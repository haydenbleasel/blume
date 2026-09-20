import type { JsonObject } from "./json.ts";
import { asObject, asString, isJsonObject, objectsIn } from "./json.ts";
import { lexicalToMarkdown } from "./lexical.ts";
import type { RemoteFieldMap, RestClient } from "./remote.ts";
import {
  documentEntry,
  fetchJson,
  queryString,
  remoteSource,
} from "./remote.ts";
import type { ContentSource, SourceContext, SourceEntry } from "./types.ts";

export interface PayloadSourceOptions {
  name: string;
  prefix?: string;
  /** The Payload app's origin (`https://cms.acme.dev`); its REST API is at `/api`. */
  url: string;
  /** The collection slug whose documents become pages. */
  collection: string;
  /**
   * The auth-enabled collection the API key belongs to; default `users`. It
   * names the scheme in the `Authorization` header (`users API-Key <key>`).
   */
  authCollection?: string;
  /** Relationship depth to populate; default `1`, enough for upload URLs. */
  depth?: number;
  /**
   * Field paths mapping a document onto Blume meta + body. Defaults:
   * `title`, `description`, `slug`, `content`, `updatedAt`.
   */
  fields?: RemoteFieldMap;
  /** Extra query parameters for the collection request (`where[...]`, `sort`). */
  params?: Record<string, string>;
  /** Serializers for `block`/`inlineBlock` nodes, keyed by `blockType`. */
  serializers?: Record<string, (fields: JsonObject) => string>;
  /** API key; defaults to `PAYLOAD_API_KEY`. */
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
 * Payload content source. Pages through a collection's REST endpoint, maps
 * each document's fields to frontmatter, and lowers its Lexical body to
 * Markdown. Published documents only, unless `--preview` asks for drafts.
 */
export const payloadSource = (
  options: PayloadSourceOptions,
  ctx?: SourceContext
): ContentSource => {
  const fields = { ...DEFAULT_FIELDS, ...options.fields };
  const origin = options.url.replace(/\/+$/u, "");

  const lower = (body: JsonObject): string =>
    lexicalToMarkdown(body, {
      baseUrl: origin,
      serializers: options.serializers,
    });

  const fetchEntries = async (): Promise<SourceEntry[]> => {
    const preview = ctx?.preview ?? false;
    const token = options.token ?? process.env.PAYLOAD_API_KEY;
    const client: RestClient = {
      fetchImpl: options.fetchImpl,
      headers: token
        ? {
            authorization: `${options.authCollection ?? "users"} API-Key ${token}`,
          }
        : {},
    };
    const base = `${origin}/api/${options.collection}`;
    const entries: SourceEntry[] = [];
    let page = 1;
    let more = true;
    while (more) {
      const query = queryString({
        depth: String(options.depth ?? 1),
        draft: preview ? "true" : undefined,
        limit: String(PAGE_SIZE),
        page: String(page),
        ...options.params,
      });
      // oxlint-disable-next-line no-await-in-loop -- pages are sequential: each response says whether another exists.
      const result = asObject(await fetchJson(`${base}?${query}`, client));
      if (!result) {
        throw new Error("Payload returned a non-object response");
      }
      for (const doc of objectsIn(result.docs)) {
        const draft = asString(doc._status) === "draft";
        if (draft && !preview) {
          continue;
        }
        const id = asString(doc.id) ?? String(doc.id ?? "");
        entries.push(
          documentEntry(
            doc,
            fields,
            id,
            (body) => (isJsonObject(body) ? lower(body) : ""),
            draft
          )
        );
      }
      more = result.hasNextPage === true;
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
