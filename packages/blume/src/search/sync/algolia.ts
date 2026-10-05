import type * as AlgoliaSdk from "algoliasearch";

import { nodeRequire } from "../../core/node-require.ts";
import type { AlgoliaOptions } from "../adapters/algolia.ts";
import type { SearchRecord } from "../documents.ts";

/** The adapter options the sync reads (the public `apiKey` is never used). */
export type AlgoliaSyncConfig = Pick<AlgoliaOptions, "appId" | "indexName">;

/**
 * The record attributes the search dialog filters on (`facetFilters` on
 * `locale:<code>` and `version:<id>`). In Algolia a facet filter on an
 * attribute the index doesn't declare for faceting matches nothing — an i18n
 * or versioned site would get no hits — so the sync declares them,
 * filter-only.
 */
const FILTER_ATTRIBUTES = ["locale", "version"] as const;

/** The custom ranking rule that orders close matches by `search.boost`. */
const BOOST_RANKING = "desc(boost)";

/** A faceting declaration's attribute: `filterOnly(locale)` → `locale`. */
const facetAttribute = (declaration: string): string =>
  declaration.replace(/^\w+\((?<name>.*)\)$/u, "$<name>");

/**
 * The largest record Algolia accepts on its Build and Grow plans, in bytes of
 * the record's JSON. One larger record fails the whole upload.
 */
const MAX_RECORD_BYTES = 10_000;

/**
 * A record as uploaded: the search record's fields plus Algolia's `objectID`.
 * (Mapped rather than the interface itself, which the SDK's
 * `Record<string, unknown>` objects don't accept.)
 */
type AlgoliaObject = Pick<SearchRecord, keyof SearchRecord> & {
  objectID: string;
};

/** A string's or record's size as Algolia measures it: UTF-8 bytes of its JSON. */
const jsonBytes = (value: string | AlgoliaObject): number =>
  Buffer.byteLength(JSON.stringify(value), "utf-8");

/** The JSON of the widest single character: a control character's `\u` escape. */
const WIDEST_CHARACTER = jsonBytes("\u0000");

/** The length of `text`'s longest prefix whose JSON string fits `budget`. */
const fittingLength = (text: string, budget: number): number => {
  let size = jsonBytes("");
  let end = 0;
  [...text].some((character) => {
    size += jsonBytes(character) - jsonBytes("");
    if (size > budget) {
      return true;
    }
    end += character.length;
    return false;
  });
  return end;
};

/**
 * Cut `text` into pieces whose JSON strings fit `budget` bytes each, at the
 * last space that fits so no word is split; a run with no space in reach (an
 * unspaced script, a long URL) is cut between characters.
 */
const splitText = (text: string, budget: number): string[] => {
  const pieces: string[] = [];
  let rest = text;
  while (jsonBytes(rest) > budget) {
    const end = fittingLength(rest, budget);
    const space = rest.lastIndexOf(" ", end);
    const cut = space > 0 ? space : end;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  pieces.push(rest);
  return pieces;
};

/**
 * A page's record, split to fit Algolia's cap the way Algolia recommends for
 * long documents: every piece carries the page's title, description, URL and
 * facets with a stretch of its body, and the index's `distinct` on `url`
 * shows the page once, at its best-matching piece. The first piece keeps the
 * page's own `objectID`; the rest add `#1`, `#2`… A record whose other fields
 * leave no room for a single character of body can't be split to fit, and
 * uploads whole for Algolia to reject by name.
 */
const toObjects = (record: SearchRecord): AlgoliaObject[] => {
  const whole = { ...record, objectID: record._id };
  const budget =
    MAX_RECORD_BYTES -
    jsonBytes({ ...whole, content: "", objectID: `${record._id}#000` }) +
    jsonBytes("");
  if (jsonBytes(whole) <= MAX_RECORD_BYTES || budget < WIDEST_CHARACTER) {
    return [whole];
  }
  return splitText(record.content, budget).map((content, index) => ({
    ...record,
    content,
    objectID: index === 0 ? record._id : `${record._id}#${index}`,
  }));
};

/**
 * Upload the search records to Algolia. Uses the admin key from
 * `ALGOLIA_ADMIN_API_KEY` (never the adapter options, which hold only the
 * public, search-only key). Throws on a missing key so the caller can warn.
 *
 * Uses `replaceAllObjects`, which atomically replaces the index contents, so
 * pages deleted or renamed since the last sync don't linger as stale search
 * hits that 404 when clicked. A page too long for one record is split across
 * several (see {@link toObjects}). Then adds `filterOnly(locale)` and
 * `filterOnly(version)` to the index's `attributesForFaceting`, keeping any
 * the site declared itself, so the dialog's locale and version filters match,
 * and, once a page is split, `url` as the index's `attributeForDistinct`
 * unless the site set its own.
 */
export const syncAlgolia = async (
  records: SearchRecord[],
  config: AlgoliaSyncConfig
): Promise<void> => {
  const adminKey = process.env.ALGOLIA_ADMIN_API_KEY;
  if (!adminKey) {
    throw new Error("ALGOLIA_ADMIN_API_KEY is not set.");
  }
  // `require`, not `import()`: this runs in `astro:build:done` (see
  // `core/node-require.ts`).
  const { algoliasearch }: typeof AlgoliaSdk = nodeRequire("algoliasearch");
  const client = algoliasearch(config.appId, adminKey);
  const { indexName } = config;
  const objects = records.flatMap(toObjects);
  await client.replaceAllObjects({ indexName, objects });
  const {
    attributeForDistinct,
    attributesForFaceting = [],
    customRanking = [],
  } = await client.getSettings({ indexName });
  const declared = new Set(attributesForFaceting.map(facetAttribute));
  const missing = FILTER_ATTRIBUTES.filter((name) => !declared.has(name));
  // Every record carries `boost` (search.boost, 1 by default): ranking by it
  // after textual relevance puts boosted pages first among close matches.
  // A ranking the site set in the dashboard keeps its place ahead of it.
  const ranksByBoost = customRanking.some((rule) =>
    /^(?:asc|desc)\(boost\)$/u.test(rule)
  );
  // A split page's records share its `url`: distinct on it lists the page
  // once, at its best-matching record.
  const setsDistinct =
    objects.length > records.length && attributeForDistinct === undefined;
  if (missing.length === 0 && ranksByBoost && !setsDistinct) {
    return;
  }
  const { taskID } = await client.setSettings({
    indexName,
    indexSettings: {
      attributesForFaceting: [
        ...attributesForFaceting,
        ...missing.map((name) => `filterOnly(${name})`),
      ],
      customRanking: ranksByBoost
        ? customRanking
        : [...customRanking, BOOST_RANKING],
      ...(setsDistinct && { attributeForDistinct: "url", distinct: true }),
    },
  });
  await client.waitForTask({ indexName, taskID });
};
