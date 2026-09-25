import { z } from "zod";

import {
  mountBasePath,
  normalizeRoute as normalizePageRoute,
  stripBasePath,
} from "../../core/base-path.ts";
import { absoluteUrl } from "../../core/site-url.ts";
import { trimEnd } from "../../core/trim.ts";
import type { Navigation } from "../../core/types.ts";
import { buildOramaIndex, queryOramaIndex } from "../../search/orama-index.ts";
import type { OramaDoc } from "../../search/orama-index.ts";
import type { McpData } from "./data.ts";

/**
 * The read-only docs operations behind the agent-facing surfaces — search,
 * page lookup, the page listing, and the navigation tree — over an
 * {@link McpData} snapshot. The MCP server (`server.ts`) and the JSON docs API
 * (`ai/api/handlers.ts`) are both thin transports over these, so a tool call
 * and its REST twin can never answer differently. SDK-free on purpose: the
 * prerendered API endpoints import this module without pulling the MCP SDK
 * into their bundle.
 *
 * Each input is defined once in Zod: the runtime parse and the JSON Schema
 * advertised by `tools/list` (via `z.toJSONSchema`) derive from the same
 * definition, so they cannot drift.
 */

/** Default and maximum number of hits returned by a search. */
export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 20;
/** Excerpt length when a page has no description. */
const EXCERPT_LENGTH = 200;

// Each field is a preprocess pipe: the input side accepts the sloppy shapes
// LLM callers actually send (a bare string for an array field, `[]`/`{}`
// meaning "no filter", out-of-range limits clamped rather than rejected), and
// the pipe's *output* side is the clean shape — which is exactly what
// `z.toJSONSchema` emits for `tools/list`. No coercion can ever fail, so a
// tool call is never rejected on argument shape, matching the previous
// hand-rolled coercions.

/**
 * The optional content-type filter `search_docs` and `list_pages` share.
 * `[]` or no usable strings mean "no filter", not "match nothing"; a bare
 * string is accepted as a one-element list.
 */
const contentTypesField = z.preprocess((value) => {
  const list = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string => typeof entry === "string"
  );
  return list.length > 0 ? list : undefined;
}, z.array(z.string()).optional().describe('Only include pages of these content types (frontmatter `type`, e.g. `["doc", "rfc"]`). `list_pages` shows each page\'s type. Omit to include every type.'));

/**
 * The optional facet filter `search_docs` and `list_pages` share. Only
 * string-valued entries survive; an empty `{}` means "no filter".
 */
/** Accepts any plain object, so the string-valued entries can be sifted out. */
const looseFacetObject = z.record(z.string(), z.unknown());

const filtersField = z.preprocess((value) => {
  const candidate = looseFacetObject.safeParse(value);
  if (!candidate.success) {
    return;
  }
  const entries = Object.entries(candidate.data).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}, z.record(z.string(), z.string()).optional().describe('Only include pages matching every facet, key → required value (e.g. `{"status": "enforced"}`). Facets are metadata the site declares per content type; `list_pages` shows each page\'s facet values. Omit for no facet filtering.'));

/** Clamped into range rather than rejected; non-numeric means the default. */
const limitField = z.preprocess(
  (value) => {
    // `Number` is the identity on numbers, so one conversion covers both the
    // well-typed call and a numeric string.
    const num = Number(value);
    return Number.isFinite(num)
      ? Math.min(Math.max(Math.trunc(num), 1), MAX_SEARCH_LIMIT)
      : undefined;
  },
  z
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`Maximum hits to return (default ${DEFAULT_SEARCH_LIMIT}).`)
);

/** A required text field; a missing or non-string value coerces to "". */
const textField = (description: string) =>
  z.preprocess((value) => {
    const parsed = z.string().safeParse(value);
    return parsed.success ? parsed.data : "";
  }, z.string().describe(description));

/** An optional trimmed text field; blank or non-string means "absent". */
const optionalTextField = (description: string) =>
  z.preprocess((value) => {
    const parsed = z.string().safeParse(value);
    const trimmed = parsed.success ? parsed.data.trim() : "";
    return trimmed || undefined;
  }, z.string().optional().describe(description));

/** The optional locale filter `search_docs` and `list_pages` share. */
const localeField = optionalTextField(
  "Only include pages in this locale (e.g. `fr`). Omit for every language."
);

/** The optional docs-version scope `search_docs` and `list_pages` share. */
const versionField = optionalTextField(
  'Docs version to scope to on a versioned site: `"latest"` (the default — current docs only), `"all"` (every version), or an archived version id (e.g. `"v1.0"`). Ignored when the site is unversioned.'
);

/** Every tool's input schema — the runtime parse and tools/list source. */
export const TOOL_INPUTS = {
  get_navigation: z.object({
    locale: optionalTextField(
      "Locale whose navigation tree to return (defaults to the default locale)."
    ),
    version: optionalTextField(
      "Archived version id whose tree to return (defaults to the current docs)."
    ),
  }),
  get_page: z.object({
    route: textField("The page route, e.g. `/guides/install`."),
  }),
  list_pages: z.object({
    contentTypes: contentTypesField,
    filters: filtersField,
    locale: localeField,
    version: versionField,
  }),
  search_docs: z.object({
    contentTypes: contentTypesField,
    filters: filtersField,
    limit: limitField,
    locale: localeField,
    query: textField("The search query."),
    version: versionField,
  }),
};

/** One `search_docs` result entry; `version` only appears on versioned sites. */
export interface SearchHitPayload {
  contentType: string | undefined;
  excerpt: string;
  facets: Record<string, string> | undefined;
  route: string;
  title: string;
  url: string;
  version?: string;
}

/** One `list_pages` entry; `version` only appears on versioned sites. */
export interface PageListingPayload {
  contentType: string;
  description: string | undefined;
  facets: Record<string, string> | undefined;
  lastModified: string | null;
  route: string;
  title: string;
  url: string;
  version?: string;
}

/** Whether a page's facet values satisfy every requested filter entry. */
const matchesFacets = (
  facets: Record<string, string> | undefined,
  filters: Record<string, string>
): boolean =>
  Object.entries(filters).every(([key, value]) => facets?.[key] === value);

/**
 * Resolve the `version` scope on a versioned site: `undefined` disables the
 * filter (`"all"`), `""` is the current docs (the default — agents almost
 * always want the live documentation), and anything else is an archived id
 * (an unknown id simply matches nothing). On an unversioned site the input is
 * ignored entirely. The input arrives pre-trimmed (blank coerced to absent)
 * from the tool's input schema.
 */
const asVersionScope = (
  value: string | undefined,
  data: McpData
): string | undefined => {
  if (!data.archivedVersions) {
    return;
  }
  if (value === "all") {
    return;
  }
  if (value === undefined || value === "latest" || value === "current") {
    return "";
  }
  return value;
};

/**
 * Error message for a `get_navigation` version id that isn't a configured
 * archived version, or `null` when the id is valid (or the site is
 * unversioned, where the id is ignored like the other tools' scopes). Unlike
 * `asVersionScope`'s match-nothing filters, a bad id here would otherwise
 * silently return the *current* tree posing as the requested snapshot.
 */
const unknownVersionError = (
  versionId: string | undefined,
  data: McpData
): string | null =>
  versionId &&
  data.archivedVersions &&
  !data.archivedVersions.includes(versionId)
    ? `Unknown version "${versionId}". Archived versions: ${data.archivedVersions.join(", ")}.`
    : null;

/**
 * Normalize a user-supplied route to a `pages` key (`/`, `/a/b`, no suffix).
 * Accepts a full URL too — `search_docs` hits and llms.txt entries carry
 * `site` + `deployment.base`, and an agent following "pass a route from
 * `search_docs`" will hand one straight back — reducing it to its base-less,
 * percent-decoded path.
 */
export const normalizeRoute = (input: string, data: McpData): string => {
  let value = input.trim();
  if (/^https?:\/\//iu.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      // Not parseable as a URL after all; treat it as a path.
    }
  }
  try {
    value = decodeURI(value);
  } catch {
    // Malformed percent sequence — compare it as written.
  }
  // Trailing slashes come off before the suffix so `/a/b.md/` still loses its
  // `.md`; normalizePageRoute then settles the leading slash.
  const noSuffix = trimEnd(value, "/").replace(/\.mdx?$/u, "");
  return stripBasePath(data.base, normalizePageRoute(noSuffix));
};

/** Build the absolute (or root-relative) URL for a route. */
export const urlFor = (route: string, data: McpData): string => {
  // Routes are base-less manifest paths; layer `deployment.base` on top so the
  // URL matches where the page is served (the sitemap/llms.txt convention).
  const path = mountBasePath(data.base, route);
  // Concatenate rather than `new URL(path, site)` — a root-absolute path
  // would drop the base path of a subpath deployment (`acme.com/docs`).
  return data.site ? absoluteUrl(data.site, path) : path;
};

/** A hit's excerpt: its description, else the head of its content with an
 * ellipsis only when something was actually cut off. */
const excerptFor = (doc: OramaDoc): string => {
  if (doc.description) {
    return doc.description;
  }
  const head = doc.content.slice(0, EXCERPT_LENGTH).trim();
  return doc.content.length > EXCERPT_LENGTH ? `${head}…` : head;
};

/** Lazily builds the Orama index over a snapshot's documents, once. */
export type OramaIndexProvider = () => Promise<
  Awaited<ReturnType<typeof buildOramaIndex>>
>;

/**
 * Memoize the search index so every server built from a snapshot shares it.
 * `locale` is the snapshot's `defaultLocale`, forwarded so non-Latin scripts
 * (Japanese and Chinese, but equally Cyrillic, Greek, Hebrew, Devanagari…)
 * get a word-segmenting tokenizer.
 */
export const createIndexProvider = (
  documents: OramaDoc[],
  locale?: string
): OramaIndexProvider => {
  let dbPromise: ReturnType<OramaIndexProvider> | null = null;
  return function provideIndex() {
    dbPromise ??= buildOramaIndex(documents, locale);
    return dbPromise;
  };
};

/** Full-text search over the snapshot; the `search_docs` operation. */
export const searchDocs = async (
  data: McpData,
  index: OramaIndexProvider,
  input: z.output<typeof TOOL_INPUTS.search_docs>
): Promise<SearchHitPayload[]> => {
  const db = await index();
  const hits = await queryOramaIndex(
    db,
    input.query,
    input.limit ?? DEFAULT_SEARCH_LIMIT,
    {
      contentTypes: input.contentTypes,
      facets: input.filters,
      locale: input.locale,
      version: asVersionScope(input.version, data),
    }
  );
  // `route` is the key `get_page` takes (the tool descriptions promise
  // it); `url` is where the page is served.
  return hits.map((doc: OramaDoc) => {
    const hit: SearchHitPayload = {
      contentType: doc.contentType,
      excerpt: excerptFor(doc),
      facets: doc.facets,
      route: doc.route,
      title: doc.title,
      url: urlFor(doc.route, data),
    };
    if (data.archivedVersions) {
      hit.version = doc.version ?? "";
    }
    return hit;
  });
};

/** A page's agent Markdown, or `undefined` when no page has the route. */
export const getPageMarkdown = (
  data: McpData,
  route: string
): string | undefined => data.pages[route];

/** Every non-hidden route matching the filters; the `list_pages` operation. */
export const listPages = (
  data: McpData,
  input: z.output<typeof TOOL_INPUTS.list_pages>
): PageListingPayload[] => {
  const { contentTypes, filters, locale } = input;
  const versionScope = asVersionScope(input.version, data);
  return data.routes
    .filter(
      (route) =>
        (!contentTypes || contentTypes.includes(route.contentType)) &&
        (!filters || matchesFacets(route.facets, filters)) &&
        (!locale || route.locale === locale) &&
        (versionScope === undefined || route.version === versionScope)
    )
    .map((route) => {
      const listing: PageListingPayload = {
        contentType: route.contentType,
        description: route.description,
        facets: route.facets,
        lastModified: route.lastModified,
        route: route.route,
        title: route.title,
        url: urlFor(route.route, data),
      };
      if (data.archivedVersions) {
        listing.version = route.version;
      }
      return listing;
    });
};

/**
 * The navigation tree for a locale and version; the `get_navigation`
 * operation. A version id selects the snapshot's tree; a locale selects its
 * language (falling back through the default locale to any tree the snapshot
 * has). Without a version, a locale selects the current docs' localized
 * tree. An unknown id on a versioned site is an error string — the current
 * tree would silently masquerade as the requested snapshot.
 */
export const getNavigation = (
  data: McpData,
  input: z.output<typeof TOOL_INPUTS.get_navigation>
): { error: string } | { navigation: Navigation } => {
  const { locale, version: versionId } = input;
  const unknownVersion = unknownVersionError(versionId, data);
  if (unknownVersion) {
    return { error: unknownVersion };
  }
  let { navigation } = data;
  const byLocale = versionId
    ? data.navigationByVersion?.[versionId]
    : undefined;
  if (byLocale) {
    navigation =
      (locale ? byLocale[locale] : undefined) ??
      byLocale[data.defaultLocale ?? ""] ??
      Object.values(byLocale)[0] ??
      navigation;
  } else if (locale && data.navigationByLocale?.[locale]) {
    navigation = data.navigationByLocale[locale];
  }
  return { navigation };
};
