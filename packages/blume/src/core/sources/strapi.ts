import type { JsonObject } from "./json.ts";
import { asNumber, asObject, asString, getPath, objectsIn } from "./json.ts";
import type { RemoteFieldMap, RestClient } from "./remote.ts";
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

const DEFAULT_FIELDS: Required<RemoteFieldMap> = {
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
    const preview = ctx?.preview ?? false;
    const token = options.token ?? process.env.STRAPI_API_TOKEN;
    const client: RestClient = {
      fetchImpl: options.fetchImpl,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    const base = `${origin}/api/${options.contentType}`;
    const entries: SourceEntry[] = [];
    let page = 1;
    let more = true;
    while (more) {
      const query = queryString({
        locale: options.locale,
        "pagination[pageSize]": String(PAGE_SIZE),
        "pagination[page]": String(page),
        populate: options.populate ?? "*",
        status: preview ? "draft" : undefined,
        ...options.params,
      });
      // oxlint-disable-next-line no-await-in-loop -- pages are sequential: each response says whether another exists.
      const result = asObject(await fetchJson(`${base}?${query}`, client));
      if (!result) {
        throw new Error("Strapi returned a non-object response");
      }
      const items = objectsIn(result.data);
      for (const item of items) {
        const doc = flatten(item);
        entries.push(
          documentEntry(
            doc,
            fields,
            idOf(doc),
            (body) => strapiBlocksToMarkdown(body, { baseUrl: origin }),
            preview && doc.publishedAt === null
          )
        );
      }
      const pageCount =
        asNumber(getPath(result, "meta.pagination.pageCount")) ?? 1;
      more = items.length > 0 && page < pageCount;
      page += 1;
    }
    return entries;
  };

  return remoteSource(
    {
      fetchEntries,
      name: options.name,
      pollInterval: options.pollInterval,
      prefix: options.prefix,
    },
    ctx
  );
};
