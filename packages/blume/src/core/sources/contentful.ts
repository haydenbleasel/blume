import { BlumeError } from "../diagnostics.ts";
import type { ResolvedI18nConfig, ResolvedVersionsConfig } from "../schema.ts";
import type { Diagnostic } from "../types.ts";
import {
  assetFromEntry,
  contentfulRichTextToMarkdown,
} from "./contentful-rich-text.ts";
import type { JsonObject } from "./json.ts";
import {
  asNumber,
  asObject,
  asString,
  getPath,
  isJsonObject,
  objectsIn,
} from "./json.ts";
import { writesMdx } from "./lower.ts";
import { localizedRoute, resolveEntryRoute } from "./normalize.ts";
import type { RemoteFieldMap, RemoteFields, RestClient } from "./remote.ts";
import {
  documentEntry,
  documentSlug,
  fetchJson,
  missingSecretError,
  queryString,
  remoteSource,
} from "./remote.ts";
import type { ContentSource, SourceContext, SourceEntry } from "./types.ts";

export interface ContentfulSourceOptions {
  name: string;
  prefix?: string;
  /** Space id. */
  space: string;
  /** Environment id; default `master`. */
  environment?: string;
  /**
   * Delivery API host name; default `cdn.contentful.com`. A space with EU
   * data residency reads from `cdn.eu.contentful.com`.
   */
  host?: string;
  /**
   * Preview API host name for `--preview`; default `preview.contentful.com`
   * (`preview.eu.contentful.com` for EU data residency).
   */
  previewHost?: string;
  /** The content type id whose entries become pages. */
  contentType: string;
  /** Locale code to fetch; omit for the space's default locale. */
  locale?: string;
  /** The project's i18n config, which places an entry's route by its slug. */
  i18n?: ResolvedI18nConfig;
  /** The project's versions config, which places an entry's route by its slug. */
  versions?: ResolvedVersionsConfig;
  /**
   * Field ids mapping an entry onto Blume meta + body. Paths resolve against
   * the entry's `fields`, with `sys` reachable as `sys.<key>`. Defaults:
   * `title`, `description`, `slug`, `body`, `sys.updatedAt`.
   */
  fields?: RemoteFieldMap;
  /** Extra query parameters for the entries request (`fields.section: "sdk"`). */
  params?: Record<string, string>;
  /** Serializers for embedded entries, keyed by content type id. */
  serializers?: Record<string, (entry: JsonObject) => string>;
  /** Delivery API token; defaults to `CONTENTFUL_ACCESS_TOKEN`. */
  token?: string;
  /** Preview API token for `--preview`; defaults to `CONTENTFUL_PREVIEW_TOKEN`. */
  previewToken?: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DELIVERY_HOST = "cdn.contentful.com";
const PREVIEW_HOST = "preview.contentful.com";
const PAGE_SIZE = 100;

const DEFAULT_FIELDS: RemoteFields = {
  body: "body",
  description: "description",
  lastModified: "sys.updatedAt",
  slug: "slug",
  title: "title",
};

/** The included objects of a page, keyed by `sys.id`. */
const byId = (objects: JsonObject[]): Map<string, JsonObject> =>
  new Map(
    objects.map((object) => [asString(getPath(object, "sys.id")) ?? "", object])
  );

/** One page of the entries response: its items and what their links reach. */
interface EntriesPage {
  assets: Map<string, JsonObject>;
  items: JsonObject[];
  linked: Map<string, JsonObject>;
}

/** An entry's id, and the entry as its field paths read it. */
interface EntryView {
  id: string;
  /** The entry's fields, with `sys` beside them. */
  view: JsonObject;
}

const entryView = (item: JsonObject): EntryView => {
  const sys = asObject(item.sys) ?? {};
  return {
    id: asString(sys.id) ?? "",
    view: { ...asObject(item.fields), sys },
  };
};

/**
 * Contentful content source. Pages through the Delivery API (the Preview API
 * under `--preview`), maps each entry's fields to frontmatter, and lowers its
 * rich text body to Markdown with the page's `includes` resolving asset and
 * entry links. An entry hyperlink to another of the source's entries links
 * to that entry's page.
 */
export const contentfulSource = (
  options: ContentfulSourceOptions,
  ctx?: SourceContext
): ContentSource => {
  const fields = { ...DEFAULT_FIELDS, ...options.fields };

  // The route an entry's page publishes at: the ref `documentEntry` names it
  // by, through the resolver `normalizeEntry` uses, so an entry hyperlink
  // lands on the page that's built. A slug places a page in one locale, and
  // `.md` stands in for either extension, which the route drops.
  const routeOf = (view: JsonObject, id: string): string => {
    const route = resolveEntryRoute(
      { ref: `${documentSlug(view, fields.slug, id)}.md` },
      ".md",
      undefined,
      { i18n: options.i18n, prefix: options.prefix, versions: options.versions }
    );
    return localizedRoute(
      route.logicalRoute,
      route.locales[0] ?? "",
      options.i18n
    );
  };

  const toEntry = (
    item: JsonObject,
    { assets, linked }: EntriesPage,
    routes: Map<string, string>,
    warn: (diagnostic: Diagnostic) => void
  ): SourceEntry => {
    const { id, view } = entryView(item);
    // Links the response left out of `includes`: the API delivers no
    // unpublished, archived, or deleted target, and the page renders without
    // it.
    const missing = new Set<string>();
    const entry = documentEntry(
      view,
      fields,
      id,
      (body) =>
        isJsonObject(body)
          ? contentfulRichTextToMarkdown(body, {
              // Only an entry the source itself turns into a page has a
              // route: one of another content type, or one `params` filters
              // out, keeps its text.
              entryHref: (target) =>
                routes.get(asString(getPath(target, "sys.id")) ?? ""),
              resolveAsset: (assetId) => {
                const asset = assets.get(assetId);
                if (!asset) {
                  missing.add(`asset "${assetId}"`);
                  return null;
                }
                return assetFromEntry(asset);
              },
              resolveEntry: (entryId) => {
                const target = linked.get(entryId);
                if (!target) {
                  missing.add(`entry "${entryId}"`);
                }
                return target ?? null;
              },
              serializers: options.serializers,
            })
          : "",
      false,
      writesMdx(options.serializers)
    );
    for (const link of missing) {
      warn({
        code: "BLUME_SOURCE_UNRESOLVED_LINK",
        message: `Source "${options.name}": "${entry.ref}" links to Contentful ${link}, which the response didn't include, so the page renders without it.`,
        severity: "warning",
        suggestion:
          "Publish the linked asset or entry, or remove the link: the Delivery API returns only published content.",
      });
    }
    return entry;
  };

  const preview = ctx?.preview ?? false;
  const previewToken = (): string | undefined =>
    options.previewToken ?? process.env.CONTENTFUL_PREVIEW_TOKEN;

  // The Preview API rejects delivery tokens, so falling back to one would
  // only trade a clear config error for a 401. Checked before the cache, so
  // a warm snapshot can't stand in for the drafts `--preview` asked for.
  const assertConfigured = (): void => {
    if (preview && !previewToken()) {
      throw new BlumeError({
        code: "BLUME_SOURCE_MISCONFIGURED",
        message: `Source "${options.name}": Contentful --preview needs a Preview API token.`,
        severity: "error",
        suggestion:
          "Set previewToken on contentfulSource, or the CONTENTFUL_PREVIEW_TOKEN environment variable.",
      });
    }
  };

  const fetchEntries = async (
    warn: (diagnostic: Diagnostic) => void
  ): Promise<SourceEntry[]> => {
    const token = preview
      ? previewToken()
      : (options.token ?? process.env.CONTENTFUL_ACCESS_TOKEN);
    // The Delivery API answers nothing without a token (`assertConfigured`
    // already required the preview one).
    if (!token) {
      throw missingSecretError(options.name, "CONTENTFUL_ACCESS_TOKEN");
    }
    const client: RestClient = {
      fetchImpl: options.fetchImpl,
      headers: { authorization: `Bearer ${token}` },
    };
    const host = preview
      ? (options.previewHost ?? PREVIEW_HOST)
      : (options.host ?? DELIVERY_HOST);
    const base = `https://${host}/spaces/${options.space}/environments/${options.environment ?? "master"}/entries`;
    const pages: EntriesPage[] = [];
    let skip = 0;
    let more = true;
    while (more) {
      // The user's params go first so the paging controls always win — a
      // `params` key that shadowed them would refetch the same page forever.
      const query = queryString({
        ...options.params,
        content_type: options.contentType,
        include: "2",
        limit: String(PAGE_SIZE),
        locale: options.locale,
        skip: String(skip),
      });
      // oxlint-disable-next-line no-await-in-loop -- pages are sequential: each response says whether another exists.
      const page = asObject(await fetchJson(`${base}?${query}`, client));
      if (!page) {
        throw new Error("Contentful returned a non-object response");
      }
      const items = objectsIn(page.items);
      pages.push({
        assets: byId(objectsIn(getPath(page, "includes.Asset"))),
        items,
        // `includes` leaves out an entry the page's `items` already hold, so
        // a link to one of those resolves from `items`.
        linked: byId([...objectsIn(getPath(page, "includes.Entry")), ...items]),
      });
      skip += items.length;
      more = items.length > 0 && skip < (asNumber(page.total) ?? 0);
    }
    // A link can reach an entry a later page delivers, so every entry's route
    // is known before any body lowers.
    const routes = new Map(
      pages.flatMap(({ items }) =>
        items.map((item): [string, string] => {
          const { id, view } = entryView(item);
          return [id, routeOf(view, id)];
        })
      )
    );
    return pages.flatMap((page) =>
      page.items.map((item) => toEntry(item, page, routes, warn))
    );
  };

  return remoteSource(
    {
      assertConfigured,
      fetchEntries,
      name: options.name,
      pollInterval: options.pollInterval,
      prefix: options.prefix,
      withContext: (next) => contentfulSource(options, next),
    },
    ctx
  );
};
