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
 * Upload the search records to Algolia. Uses the admin key from
 * `ALGOLIA_ADMIN_API_KEY` (never the adapter options, which hold only the
 * public, search-only key). Throws on a missing key so the caller can warn.
 *
 * Uses `replaceAllObjects`, which atomically replaces the index contents, so
 * pages deleted or renamed since the last sync don't linger as stale search
 * hits that 404 when clicked. Then adds `filterOnly(locale)` and
 * `filterOnly(version)` to the index's `attributesForFaceting`, keeping any
 * the site declared itself, so the dialog's locale and version filters match.
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
  await client.replaceAllObjects({
    indexName,
    objects: records.map((record) => ({ ...record, objectID: record._id })),
  });
  const { attributesForFaceting = [], customRanking = [] } =
    await client.getSettings({ indexName });
  const declared = new Set(attributesForFaceting.map(facetAttribute));
  const missing = FILTER_ATTRIBUTES.filter((name) => !declared.has(name));
  // Every record carries `boost` (search.boost, 1 by default): ranking by it
  // after textual relevance puts boosted pages first among close matches.
  // A ranking the site set in the dashboard keeps its place ahead of it.
  const ranksByBoost = customRanking.some((rule) =>
    /^(?:asc|desc)\(boost\)$/u.test(rule)
  );
  if (missing.length === 0 && ranksByBoost) {
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
    },
  });
  await client.waitForTask({ indexName, taskID });
};
