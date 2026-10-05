import type { JsonObject } from "./json.ts";
import { asNumber, asObject, asString, getPath, objectsIn } from "./json.ts";
import type { RemoteFieldMap, RemoteFields, RestClient } from "./remote.ts";
import {
  documentEntry,
  fetchJson,
  queryString,
  remoteSource,
} from "./remote.ts";
import { strapiBlocksToMarkdown } from "./strapi-blocks.ts";
import type { ContentSource, SourceContext, SourceEntry } from "./types.ts";

export interface StrapiSourceOptions {
  name: string;
  prefix?: string;
  /** The Strapi origin (`https://cms.acme.dev`); its REST API is at `/api`. */
  url: string;
  /** The content type's plural API id (`articles`). */
  contentType: string;
  /** Locale code to fetch, for a localized content type. */
  locale?: string;
  /** The `populate` parameter; default `*`, which fills media and relations. */
  populate?: string;
  /**
   * Field paths mapping an entry onto Blume meta + body. Defaults:
   * `title`, `description`, `slug`, `content`, `updatedAt`.
   */
  fields?: RemoteFieldMap;
  /** Extra query parameters for the request (`filters[...]`, `sort`). */
  params?: Record<string, string>;
  /** API token; defaults to `STRAPI_API_TOKEN`. */
  token?: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const PAGE_SIZE = 100;

const DEFAULT_FIELDS: RemoteFields = {
  body: "content",
  description: "description",
  lastModified: "updatedAt",
  slug: "slug",
  title: "title",
};

/**
 * The entry as a flat document. Strapi 5 returns fields at the top level
 * beside `documentId`; Strapi 4 wraps them in `attributes` under a numeric
 * `id`, and that envelope is flattened so the same field paths apply.
 */
const flatten = (item: JsonObject): JsonObject => {
  const attributes = asObject(item.attributes);
  return attributes ? { ...attributes, id: item.id ?? null } : item;
};

const idOf = (doc: JsonObject): string => {
  const raw = doc.documentId ?? doc.id;
  return asString(raw) ?? String(asNumber(raw) ?? "");
};

/** Every entry one query returns, across its pages, flattened. */
interface StrapiListing {
  docs: JsonObject[];
  /** Whether any entry came in Strapi 4's `attributes` envelope. */
  v4: boolean;
}

/** Strapi 4 marks an unpublished entry with a null `publishedAt`. */
const unpublished = (doc: JsonObject): boolean => doc.publishedAt === null;

/**
 * Strapi content source. Pages through a content type's REST endpoint, maps
 * each entry's fields to frontmatter, and lowers its Blocks body to
 * Markdown. Published entries only, unless `--preview` asks for drafts.
 */
export const strapiSource = (
  options: StrapiSourceOptions,
  ctx?: SourceContext
): ContentSource => {
  const fields = { ...DEFAULT_FIELDS, ...options.fields };
  const origin = options.url.replace(/\/+$/u, "");

  const fetchEntries = async (): Promise<SourceEntry[]> => {
    const token = options.token ?? process.env.STRAPI_API_TOKEN;
    const client: RestClient = {
      fetchImpl: options.fetchImpl,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    const base = `${origin}/api/${options.contentType}`;

    const list = async (
      publication: Record<string, string>
    ): Promise<StrapiListing> => {
      const listing: StrapiListing = { docs: [], v4: false };
      let page = 1;
      let more = true;
      while (more) {
        // The user's params go first so the paging controls always win — a
        // `params` key that shadowed them would refetch the same page forever.
        const query = queryString({
          ...options.params,
          locale: options.locale,
          "pagination[pageSize]": String(PAGE_SIZE),
          "pagination[page]": String(page),
          populate: options.populate ?? "*",
          ...publication,
        });
        // oxlint-disable-next-line no-await-in-loop -- pages are sequential: each response says whether another exists.
        const result = asObject(await fetchJson(`${base}?${query}`, client));
        if (!result) {
          throw new Error("Strapi returned a non-object response");
        }
        const items = objectsIn(result.data);
        for (const item of items) {
          listing.v4 ||= asObject(item.attributes) !== undefined;
          listing.docs.push(flatten(item));
        }
        const pageCount =
          asNumber(getPath(result, "meta.pagination.pageCount")) ?? 1;
        more = items.length > 0 && page < pageCount;
        page += 1;
      }
      return listing;
    };

    const toEntries = (
      docs: JsonObject[],
      isDraft: (doc: JsonObject) => boolean
    ): SourceEntry[] =>
      docs.map((doc) =>
        documentEntry(
          doc,
          fields,
          idOf(doc),
          (body) => strapiBlocksToMarkdown(body, { baseUrl: origin }),
          isDraft(doc)
        )
      );

    // The default publication state is the published one in both Strapi 4
    // and 5, and its response shape says which version is answering.
    const published = await list({});
    if (!ctx?.preview) {
      return toEntries(published.docs, () => false);
    }
    // Strapi 4 previews with `publicationState=preview`, which returns drafts
    // and published entries together, a draft's `publishedAt` being null.
    if (published.v4) {
      const previewed = await list({ publicationState: "preview" });
      return toEntries(previewed.docs, unpublished);
    }
    // Strapi 5 answers `status=draft` with the draft version of every
    // document, `publishedAt` null even when a published version exists, so a
    // document is a draft only when it has no published version.
    const drafts = await list({ status: "draft" });
    if (drafts.docs.length === 0 && published.docs.length === 0) {
      // Strapi 4 ignores `status`, so a Strapi 4 content type holding only
      // drafts reads as empty on both requests. Ask with its own parameter;
      // Strapi 5 either ignores it or rejects it (`strictParams`), and in
      // both cases has nothing more to return.
      const previewed = await list({ publicationState: "preview" }).catch(
        () => null
      );
      return previewed ? toEntries(previewed.docs, unpublished) : [];
    }
    const publishedIds = new Set(published.docs.map(idOf));
    const draftIds = new Set(drafts.docs.map(idOf));
    // A published document with no draft version (a content type without
    // Draft & Publish) still belongs in the preview.
    return [
      ...toEntries(drafts.docs, (doc) => !publishedIds.has(idOf(doc))),
      ...toEntries(
        published.docs.filter((doc) => !draftIds.has(idOf(doc))),
        () => false
      ),
    ];
  };

  return remoteSource(
    {
      fetchEntries,
      name: options.name,
      pollInterval: options.pollInterval,
      prefix: options.prefix,
      withContext: (next) => strapiSource(options, next),
    },
    ctx
  );
};
