import type { AstroIntegration } from "astro";
import { z } from "zod";

import type { ComponentMarkdown } from "../ai/component-markdown.ts";
import type { CodeTheme } from "../markdown/themes.ts";
import { normalizeRoute } from "../openapi/references.ts";
import { normalizeXHandle } from "../seo/x-handle.ts";
import { FONT_SLUGS, isFontSlug } from "../theme/fonts.ts";
import { normalizeBasePath } from "./base-path.ts";
import { uiLocaleOverridesSchema } from "./i18n-ui.ts";
import { openInChatProviders } from "./open-in-chat.ts";
import type { ContentSource } from "./sources/types.ts";
import { isStandardSchema } from "./standard-schema.ts";
import type { StandardSchema } from "./standard-schema.ts";

/**
 * Public Blume schemas.
 *
 * These are exported from `blume/schema` so migration tools, editor
 * integrations, and the runtime share a single source of validation truth.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

// `typeof` checks live in named predicates (the form the oxlint anti-slop
// config sanctions); generic so each site keeps its own union narrowing.
const isString = <Value>(value: Value): value is Value & string =>
  typeof value === "string";

const isBoolean = <Value>(value: Value): value is Value & boolean =>
  typeof value === "boolean";

/** Icon inputs in serializable contexts (frontmatter, meta files). */
const iconName = z.string().min(1);

/** Default include glob for filesystem-backed content sources. */
const DEFAULT_CONTENT_GLOB = "**/*.{md,mdx}";

const hydrationMode = z.enum(["load", "idle", "visible", "media", "only"]);
export type HydrationMode = z.infer<typeof hydrationMode>;

/**
 * A publish date in frontmatter. YAML auto-parses an unquoted `2026-01-01` into
 * a `Date`, so accept either form and normalize to an ISO string.
 */
const dateSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value));

/**
 * How a sidebar group renders:
 * - `flat`: a non-collapsible header with its items listed beneath (default).
 * - `group`: a collapsible `<details>` disclosure.
 * - `page`: a single row that drills into a sub-panel showing only this group's
 *   items, with a back arrow at the top.
 */
const sidebarDisplaySchema = z.enum(["flat", "group", "page"]);
export type SidebarDisplay = z.infer<typeof sidebarDisplaySchema>;

// ---------------------------------------------------------------------------
// Page frontmatter
// ---------------------------------------------------------------------------

const sidebarMetaSchema = z.strictObject({
  badge: z.string().optional(),
  /**
   * Render mode for this page's folder group. Only meaningful on a folder's
   * `index` page — it configures the group, not the page. Overrides the
   * folder's `meta.ts` `display` and the global `navigation.sidebar.display`.
   */
  display: sidebarDisplaySchema.optional(),
  hidden: z.boolean().default(false),
  icon: iconName.optional(),
  label: z.string().optional(),
  order: z.number().optional(),
});

/**
 * An X handle, normalized to a leading `@` — `twitter:site`/`twitter:creator`
 * require it, and a handle configured without one is the obvious typo to absorb
 * rather than reject. The layouts normalize again on the way out, since a page's
 * `seo.x.creator` reaches them straight from unvalidated frontmatter.
 */
const xHandleSchema = z.string().transform(normalizeXHandle).optional();

const seoMetaSchema = z.strictObject({
  canonical: z.url().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  noindex: z.boolean().default(false),
  title: z.string().optional(),
  /** Per-page X attribution — a guest post credits its own author. */
  x: z.strictObject({ creator: xHandleSchema }).optional(),
});

const searchMetaSchema = z.strictObject({
  boost: z.number().optional(),
  exclude: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
});

const aiMetaSchema = z.strictObject({
  /** Exclude this page from llms.txt and llms-full.txt. */
  exclude: z.boolean().default(false),
});

const changelogMetaSchema = z.strictObject({
  category: z.string().optional(),
  date: dateSchema.optional(),
  version: z.string().optional(),
});

/**
 * A post author: a bare name/handle, or an object with a name plus optional
 * avatar/URL. The object is passthrough so richer author metadata (social
 * handles, roles) survives untouched — Blume doesn't render authors yet, so
 * this exists to preserve the field (common on blog/changelog pages) rather
 * than have a strict scan reject it.
 */
const authorSchema = z.union([
  z.string(),
  z
    .object({
      avatar: z.string().optional(),
      image: z.string().optional(),
      name: z.string(),
      url: z.string().optional(),
    })
    .catchall(z.unknown()),
]);

// Shorthand defaults use `.prefault()`, not `.default()`, wherever the value
// must still be parsed — Zod 4's `.default()` returns the value as-is, so a
// `.default({})` on an object with inner defaults (or a transform) would
// resolve to a bare `{}` instead of the fully-defaulted shape.

/** Frontmatter accepted on any content page. */
const pageMetaBaseSchema = z.strictObject({
  ai: aiMetaSchema.prefault({}),
  /** Post author(s) for blog/changelog content; preserved, not yet rendered. */
  authors: z.union([authorSchema, z.array(authorSchema)]).optional(),
  changelog: changelogMetaSchema.optional(),
  /** Publish date for feed-backed content like blog/changelog. */
  date: dateSchema.optional(),
  deprecated: z.boolean().default(false),
  description: z.string().optional(),
  draft: z.boolean().default(false),
  hidden: z.boolean().default(false),
  icon: iconName.optional(),
  /** Overrides the git-derived last-modified date when `lastModified` is on. */
  lastModified: dateSchema.optional(),
  noindex: z.boolean().default(false),
  search: searchMetaSchema.prefault({}),
  seo: seoMetaSchema.prefault({}),
  sidebar: sidebarMetaSchema.prefault({}),
  slug: z.string().optional(),
  title: z.string().optional(),
  // No default: an absent `type` must fall through to `content.defaultType`.
  type: z.string().optional(),
});

export const pageMetaSchema = pageMetaBaseSchema;

export type PageMeta = z.infer<typeof pageMetaBaseSchema>;
export type PageMetaInput = z.input<typeof pageMetaBaseSchema>;

/** Built-in page frontmatter keys; custom keys must never redeclare one. */
const BUILT_IN_PAGE_META_KEYS = new Set<string>(
  pageMetaBaseSchema.keyof().options
);

/**
 * A map of custom frontmatter keys to user-supplied validation schemas,
 * consumed through the Standard Schema `~standard` contract — never Zod's own
 * API — so the consumer's zod (any version), Valibot, or ArkType all work
 * (see `standard-schema.ts`). Shared by the site-wide `frontmatter.extend`
 * and the per-type `content.types.<type>.frontmatter` maps. Built-in
 * frontmatter fields can't be redeclared — they're load-bearing (routing,
 * sidebar, SEO), and shadowing one would silently change its semantics.
 */
const customKeySchemaRecord = (where: string) =>
  z
    .record(
      z.string(),
      z.custom<StandardSchema>(isStandardSchema, {
        message:
          "Expected a Standard Schema (e.g. a Zod schema — any Zod version works).",
      })
    )
    .default({})
    .superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        if (BUILT_IN_PAGE_META_KEYS.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${key}" is a built-in frontmatter field and cannot be redeclared via ${where}.`,
            path: [key],
          });
        }
      }
    });

// ---------------------------------------------------------------------------
// Folder meta (meta.ts)
// ---------------------------------------------------------------------------

export const folderMetaSchema = z.strictObject({
  collapsed: z.boolean().optional(),
  /** Render mode for this group; overrides `navigation.sidebar.display`. */
  display: sidebarDisplaySchema.optional(),
  icon: iconName.optional(),
  order: z.number().optional(),
  /** Explicit child ordering by slug segment (without numeric prefix). */
  pages: z.array(z.string()).optional(),
  title: z.string().optional(),
});

export type FolderMeta = z.infer<typeof folderMetaSchema>;

// ---------------------------------------------------------------------------
// Project config (blume.config.ts)
// ---------------------------------------------------------------------------

/** The logo mark: a single image path/URL, or light/dark variants with alt text. */
const logoImageSchema = z.union([
  z.string(),
  z.strictObject({
    alt: z.string().optional(),
    dark: z.string().optional(),
    light: z.string().optional(),
  }),
]);

/**
 * Site logo. A bare string is the image shorthand. The object form splits the
 * brand into an optional `image` mark and optional wordmark `text` so a site can
 * show an image-only logo (a mark with the wordmark baked in), a text-only logo,
 * or both. Omit `text` to fall back to the site title; set `text: ""` to render
 * the mark alone. `href` overrides the brand link (defaults to `/`).
 */
const logoConfigSchema = z.union([
  z.string(),
  z.strictObject({
    href: z.string().optional(),
    image: logoImageSchema.optional(),
    text: z.string().optional(),
  }),
]);

/** Site-wide announcement banner: a string, or text with an optional link. */
const bannerConfigSchema = z.union([
  z.string(),
  z.strictObject({
    content: z.string(),
    /** Show a dismiss button; the choice is remembered per visitor. */
    dismissible: z.boolean().default(false),
    /** Stable key for remembering dismissal; defaults to the content. */
    id: z.string().optional(),
    link: z.strictObject({ href: z.string(), text: z.string() }).optional(),
  }),
]);

/** A local filesystem content source. */
const filesystemSourceSchema = z.strictObject({
  exclude: z.array(z.string()).default(["**/_*", "**/.*"]),
  include: z.array(z.string()).default([DEFAULT_CONTENT_GLOB]),
  /** Namespaces the source's routes under `/<prefix>/`. */
  prefix: z.string().optional(),
  root: z.string().default("docs"),
  type: z.literal("filesystem"),
});

/**
 * Remote Markdown/MDX fetched over HTTP. Enumerate files either explicitly
 * (`files` against a raw `url` base) or from a GitHub repo subtree (`github`).
 * The token, when needed, comes from `GITHUB_TOKEN` — never inlined here.
 */
const mdxRemoteSourceSchema = z.strictObject({
  /** Explicit list of source-relative file paths to fetch from `url`. */
  files: z.array(z.string()).optional(),
  /** Enumerate a GitHub repo subtree via the git-trees API. */
  github: z
    .strictObject({
      owner: z.string(),
      path: z.string().default(""),
      ref: z.string().default("main"),
      repo: z.string(),
    })
    .optional(),
  /** Glob patterns applied to enumerated refs. */
  include: z.array(z.string()).default([DEFAULT_CONTENT_GLOB]),
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval: z.number().positive().optional(),
  /** Namespaces the source's routes under `/<prefix>/`. */
  prefix: z.string().optional(),
  type: z.literal("mdx-remote"),
  /** Raw base URL, e.g. `https://raw.githubusercontent.com/acme/sdk/main/docs`. */
  url: z.string().optional(),
});

/** A Sanity dataset queried with GROQ; Portable Text bodies become Markdown. */
const sanitySourceSchema = z.object({
  /** Sanity API version (a date); default `2024-01-01`. */
  apiVersion: z.string().optional(),
  dataset: z.string(),
  /** Field paths mapping a document onto Blume meta + body. */
  fields: z
    .strictObject({
      body: z.string().optional(),
      description: z.string().optional(),
      lastModified: z.string().optional(),
      slug: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval: z.number().positive().optional(),
  prefix: z.string().optional(),
  projectId: z.string(),
  /** GROQ query selecting the documents to import. */
  query: z.string(),
  type: z.literal("sanity"),
});

/** A Notion database; pages become entries, blocks become MDX. */
const notionSourceSchema = z.object({
  /** Max concurrent Notion API requests; default 3 (Notion's per-integration pace). */
  concurrency: z.number().positive().optional(),
  database: z.string(),
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval: z.number().positive().optional(),
  prefix: z.string().optional(),
  /** Notion property names mapped onto Blume meta. */
  properties: z
    .strictObject({
      description: z.string().optional(),
      order: z.string().optional(),
      slug: z.string().optional(),
      status: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
  /** Status value treated as published; others map to `draft`. Default `Published`. */
  publishedValue: z.string().optional(),
  type: z.literal("notion"),
});

/**
 * An Obsidian vault, read in place. Wikilinks become route links and
 * `%%comments%%` are stripped at load time, so the vault stays the source of
 * truth — no export step and no generated notes in the repo.
 */
const obsidianSourceSchema = z.strictObject({
  /** Vault folder names to skip at any depth, in addition to dot-folders. */
  exclude: z.array(z.string()).optional(),
  /** Namespaces the source's routes under `/<prefix>/`; e.g. `vault`. */
  prefix: z.string().optional(),
  type: z.literal("obsidian"),
  /** Vault directory, absolute or relative to the project root. */
  vault: z.string().min(1),
});

/**
 * A repo's GitHub Releases, materialized as `type: changelog` entries — release
 * notes become the changelog with no files to maintain. A private repo reads a
 * token from `GITHUB_TOKEN`; it is never inlined here.
 */
const githubReleasesSourceSchema = z.strictObject({
  /** Include draft releases (needs a token with repo write access). */
  drafts: z.boolean().optional(),
  /** Cap the number of releases materialized, newest-first. Default 100. */
  limit: z.number().positive().optional(),
  /** Repository owner (user or org). */
  owner: z.string(),
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval: z.number().positive().optional(),
  /** Namespaces the source's routes under `/<prefix>/`; e.g. `changelog`. */
  prefix: z.string().optional(),
  /** Include prereleases. */
  prereleases: z.boolean().optional(),
  /** Repository name. */
  repo: z.string(),
  type: z.literal("github-releases"),
});

/**
 * A user-provided `ContentSource` instance, passed straight through from
 * `blume.config.ts`. This is the extension point that lets adapters with custom
 * serializers (or any backend) ship without their SDKs touching core.
 */
const customSourceSchema = z.object({
  source: z.custom<ContentSource>(
    (val): val is ContentSource =>
      typeof val === "object" &&
      val !== null &&
      "load" in val &&
      typeof val.load === "function" &&
      "name" in val &&
      typeof val.name === "string",
    { message: "custom source must be a ContentSource (with name + load)" }
  ),
  type: z.literal("custom"),
});

/** A single configured content source. */
const contentSourceSchema = z.discriminatedUnion("type", [
  filesystemSourceSchema,
  mdxRemoteSourceSchema,
  githubReleasesSourceSchema,
  sanitySourceSchema,
  notionSourceSchema,
  obsidianSourceSchema,
  customSourceSchema,
]);

/** A resolved content-source config entry (post-defaults). */
export type ContentSourceConfig = z.infer<typeof contentSourceSchema>;

/**
 * Per-type content definition. An object (rather than a bare frontmatter map)
 * so type-scoped concerns added later — search facets, templates — have a
 * home without a breaking config change.
 */
const contentTypeConfigSchema = z.strictObject({
  /**
   * Custom frontmatter keys whose values become filterable facets for pages
   * of this type — surfaced in search documents and filterable through the
   * MCP tools' `filters` input. Each name must be a custom key declared for
   * the type (in its `frontmatter` map or the site-wide `frontmatter.extend`),
   * checked at the config level where both maps are visible. Only string
   * (or number/boolean, stringified) values ever facet.
   */
  facets: z.array(z.string()).default([]),
  /**
   * Custom frontmatter keys for pages of this type, layered on top of the
   * site-wide `frontmatter.extend`. Every declared key is validated on every
   * page of the type — absent ones included — so a required schema enforces
   * the key type-wide while leaving other types untouched.
   */
  frontmatter: customKeySchemaRecord("content.types"),
});

const contentConfigSchema = z.strictObject({
  defaultType: z.string().default("doc"),
  exclude: z.array(z.string()).default(["**/_*", "**/.*"]),
  include: z.array(z.string()).default([DEFAULT_CONTENT_GLOB]),
  pages: z.string().default("pages"),
  root: z.string().default("docs"),
  /**
   * Pluggable content sources. When omitted, the top-level
   * `root`/`include`/`exclude` desugar to one implicit filesystem source, so
   * existing projects are unchanged.
   */
  sources: z.array(contentSourceSchema).optional(),
  /**
   * Per-type content definitions, keyed by the frontmatter `type` they apply
   * to (including `defaultType`, for pages that set none).
   */
  types: z.record(z.string(), contentTypeConfigSchema).default({}),
});

/**
 * A header label that may localize: a plain string, or a map of locale code to
 * label (`{ en: "Docs", ja: "ドキュメント" }`). Resolved when each locale's
 * navigation is built — the active locale's entry wins, then the default
 * locale's, then the map's first entry — so a single-locale site can keep
 * plain strings and an i18n site can translate its header without forking the
 * config.
 */
const localizableLabelSchema = z.union([
  z.string(),
  z
    .record(z.string(), z.string())
    .refine((value) => Object.keys(value).length > 0, {
      message: "Provide at least one locale's label.",
    }),
]);

export type LocalizableLabel = z.infer<typeof localizableLabelSchema>;

const navTabSchema = z.strictObject({
  // Rejected empty rather than accepted: an empty `href` would render a link to
  // nowhere, and it can't mean "resolve it for me" either — that's what
  // omitting the field does.
  href: z.string().min(1).optional(),
  icon: iconName.optional(),
  items: z
    .array(
      z.strictObject({
        description: z.string().optional(),
        icon: iconName.optional(),
        label: localizableLabelSchema,
        path: z.string(),
        tag: z.string().optional(),
      })
    )
    .optional(),
  label: localizableLabelSchema,
  path: z.string(),
});

const navSelectorItemSchema = z.strictObject({
  description: z.string().optional(),
  icon: iconName.optional(),
  label: z.string(),
  path: z.string(),
  tag: z.string().optional(),
});

const navSelectorSchema = z.strictObject({
  items: z.array(navSelectorItemSchema).default([]),
  kind: z.enum(["dropdown", "language", "product", "version"]),
  label: z.string(),
});

const directoryModeSchema = z.enum(["accordion", "card", "none"]);
export type DirectoryMode = z.infer<typeof directoryModeSchema>;

/** A node in an explicit sidebar config: a page reference or a group/link. */
export type SidebarItemConfig =
  | string
  | {
      label: string;
      badge?: string;
      directory?: DirectoryMode;
      display?: SidebarDisplay;
      href?: string;
      icon?: string;
      collapsed?: boolean;
      items?: SidebarItemConfig[];
      root?: string;
    };

// Zod 4's `ZodType` defaults its Input parameter to `unknown` (it no longer
// mirrors Output), so the recursive annotation names both — otherwise
// `z.input` of anything containing this schema degrades to `unknown`.
const sidebarItemSchema: z.ZodType<SidebarItemConfig, SidebarItemConfig> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.strictObject({
        badge: z.string().optional(),
        collapsed: z.boolean().optional(),
        directory: directoryModeSchema.optional(),
        display: sidebarDisplaySchema.optional(),
        href: z.string().optional(),
        icon: iconName.optional(),
        items: z.array(sidebarItemSchema).optional(),
        label: z.string(),
        root: z.string().optional(),
      }),
    ])
  );

const fontFallbackSchema = z.enum(["sans", "serif", "mono"]);

/** Any family from a zero-config Astro provider, by name. */
const remoteFontSchema = z.strictObject({
  fallback: fontFallbackSchema.optional(),
  name: z.string().min(1),
  provider: z
    .enum(["google", "fontsource", "bunny", "fontshare"])
    .default("google"),
  weights: z
    .array(
      z.union([z.number().int().positive(), z.string().regex(/^\d+\.\.\d+$/u)])
    )
    .nonempty()
    .optional(),
});

/** One local `@font-face`: a file plus optional weight/style (else inferred). */
const localFontVariantSchema = z.strictObject({
  src: z.string().min(1),
  style: z.enum(["normal", "italic", "oblique"]).optional(),
  weight: z
    .union([
      z.number().int().positive(),
      z.string().regex(/^\d+(?:\.\.\d+)?$/u),
    ])
    .optional(),
});

/** A self-hosted family loaded from font files in the project. */
const localFontSchema = z.strictObject({
  fallback: fontFallbackSchema.optional(),
  name: z.string().min(1),
  variants: z.array(localFontVariantSchema).nonempty(),
});

/**
 * A role's font: a curated Google Font slug (see `theme/fonts.ts`), a
 * remote-provider family, or local font files. Bare strings must be curated
 * slugs so a typo fails with the supported list instead of a provider error.
 */
const fontValueSchema = z
  .union([z.string(), remoteFontSchema, localFontSchema])
  .superRefine((value, ctx) => {
    if (isString(value) && !isFontSlug(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown font "${value}". Supported fonts: ${FONT_SLUGS.join(", ")}. For any other family, use the object form: { name: "..." } (remote provider) or { name: "...", variants: [...] } (local files).`,
      });
    }
  });

/**
 * An optional per-mode theme value: a string applies to both color modes; a
 * `{ light, dark }` object sets each mode individually (either may be
 * omitted to override a single mode).
 */
const perModeValueSchema = z
  .union([
    z.string(),
    z.strictObject({
      dark: z.string().optional(),
      light: z.string().optional(),
    }),
  ])
  .optional()
  .transform((value) =>
    isString(value) ? { dark: value, light: value } : value
  );

const themeConfigSchema = z.strictObject({
  accent: z
    .union([
      z.string(),
      z.strictObject({ dark: z.string(), light: z.string() }),
    ])
    .default("blue")
    .transform((value) =>
      isString(value) ? { dark: value, light: value } : value
    ),
  action: z.string().optional(),
  background: perModeValueSchema,
  backgroundImage: perModeValueSchema,
  fonts: z
    .strictObject({
      body: fontValueSchema.default("inter"),
      display: fontValueSchema.default("inter"),
      mono: fontValueSchema.default("ibm-plex-mono"),
    })
    .prefault({}),
  layout: z.enum(["sidebar"]).default("sidebar"),
  mode: z.enum(["system", "light", "dark"]).default("system"),
  radius: z.enum(["none", "sm", "md", "lg"]).default("md"),
});

/** Public credentials for the Algolia search backend (sync key is an env var). */
const algoliaSearchSchema = z.strictObject({
  appId: z.string(),
  indexName: z.string(),
  searchApiKey: z.string(),
});

/** Public credentials for the Orama Cloud search backend. */
const oramaCloudSearchSchema = z.strictObject({
  apiKey: z.string(),
  endpoint: z.string(),
  /** Index id used by the build-time sync (with `ORAMA_PRIVATE_API_KEY`). */
  indexId: z.string().optional(),
});

/** Public credentials for a (self-hosted or cloud) Typesense backend. */
const typesenseSearchSchema = z.strictObject({
  collection: z.string(),
  host: z.string(),
  port: z.number().int().positive().optional(),
  protocol: z.enum(["http", "https"]).optional(),
  searchApiKey: z.string(),
});

/** Mixedbread semantic search: the store the server endpoint queries. */
const mixedbreadSearchSchema = z.strictObject({
  storeId: z.string(),
});

export const searchProviders = [
  "orama",
  "pagefind",
  "flexsearch",
  "algolia",
  "orama-cloud",
  "typesense",
  "mixedbread",
  "none",
] as const;

/** Providers that need a config block, mapped to its `search.*` key. */
const PROVIDER_CONFIG_KEY = {
  algolia: "algolia",
  mixedbread: "mixedbread",
  "orama-cloud": "oramaCloud",
  typesense: "typesense",
} as const;

/** Curated link for the search dialog empty state (internal route or external URL). */
const searchPopularLinkSchema = z.strictObject({
  href: z.string(),
  icon: iconName.optional(),
  label: z.string(),
});

const searchConfigSchema = z
  .strictObject({
    algolia: algoliaSearchSchema.optional(),
    indexing: z
      .strictObject({
        includeHiddenPages: z.boolean().default(false),
      })
      .prefault({}),
    mixedbread: mixedbreadSearchSchema.optional(),
    oramaCloud: oramaCloudSearchSchema.optional(),
    /** Curated links for the Cmd+K empty state; defaults to the first sidebar pages. */
    popular: z.array(searchPopularLinkSchema).default([]),
    provider: z.enum(searchProviders).default("orama"),
    typesense: typesenseSearchSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // Hosted providers can't work without their credentials; flag a missing
    // block with a path so the diagnostic points at `search.<provider>`.
    // SAFETY: providers without a config block (orama, pagefind, …) miss the
    // map and read undefined, which the `field &&` guard below absorbs.
    const field =
      PROVIDER_CONFIG_KEY[value.provider as keyof typeof PROVIDER_CONFIG_KEY];
    if (field && !value[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `search.${field} is required when provider is "${value.provider}".`,
        path: [field],
      });
    }
  });

/** Ask AI backends. `gateway` (default) routes through the Vercel AI Gateway. */
export const askAiProviders = [
  "gateway",
  "openrouter",
  "llmgateway",
  "inkeep",
  "openai-compatible",
] as const;

/**
 * JWK parameters that carry private or secret key material (RFC 7518): the
 * private exponent/scalar, the RSA CRT parameters, and the symmetric key.
 * A directory is public by definition, so any of these in a configured key is
 * a leaked credential, not a config style choice — reject loudly.
 */
const PRIVATE_JWK_PARAMS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/**
 * A public JWK for the Web Bot Auth signature directory. Shape is left to the
 * signing setup (Ed25519 `OKP` keys in current deployments) — validation only
 * requires the mandatory `kty` and refuses private key material.
 */
const publicJwkSchema = z
  .record(z.string(), z.unknown())
  .superRefine((jwk, ctx) => {
    if (!isString(jwk.kty) || jwk.kty.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A JWK must declare its key type ("kty").',
      });
    }
    const leaked = PRIVATE_JWK_PARAMS.filter((param) => param in jwk);
    if (leaked.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `The JWK contains private key material ("${leaked.join('", "')}") — the signatures directory is public, so list only public keys and keep the private key where the signing agent runs.`,
      });
    }
  });

const mcpConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Optional system hint passed to connecting agents. */
  instructions: z.string().optional(),
  /** Server name shown to clients; defaults to the site title. */
  name: z.string().optional(),
  /**
   * Normalized like `openapi.route`: a slash-less value would otherwise be
   * string-concatenated onto the site origin (`https://acme.comdocs-mcp`).
   */
  route: z.string().default("/mcp").transform(normalizeRoute),
});

const askEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      if (value.startsWith("/") && !value.startsWith("//")) {
        return true;
      }
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    {
      message:
        "ai.ask.endpoint must be an HTTP(S) URL or a root-relative path.",
    }
  );

/** The object form of `ai.llmsTxt`; a bare boolean normalizes onto it. */
const llmsTxtObjectSchema = z.strictObject({
  /**
   * Markdown inserted after the title and summary, before the page sections:
   * the llms.txt spec's "details" slot. The place to tell agents when to use
   * the product and how to call it; trimmed, and dropped when blank.
   */
  details: z.string().trim().min(1).optional(),
  enabled: z.boolean().default(true),
  openapi: z.boolean().default(true),
});

type LlmsTxtResolved = z.output<typeof llmsTxtObjectSchema>;

const aiConfigSchema = z.strictObject({
  ask: z
    .strictObject({
      // Name of the env var holding the provider's API key; each provider has
      // a sensible default, so this only needs setting to override it.
      apiKeyEnv: z.string().optional(),
      // Base URL of the backend. Required for `openai-compatible` only when no
      // external endpoint is supplied; for named providers it overrides the preset.
      baseUrl: z.url().optional(),
      enabled: z.boolean().default(false),
      // Optional external endpoint for projects that keep their docs static
      // and host Ask AI in an existing backend. Absolute URLs and root-relative
      // paths are both valid; the built-in request/stream contract is unchanged.
      endpoint: askEndpointSchema.optional(),
      // Extra system-prompt text (identity, language, tone) appended to the
      // built-in instructions, so the grounding contract — answer from the
      // retrieved excerpts, cite pages as Markdown links — stays intact.
      instructions: z.string().trim().min(1).optional(),
      model: z.string().default("openai/gpt-5.5"),
      provider: z.enum(askAiProviders).default("gateway"),
      // How much documentation each question carries. Injected characters are
      // the dominant term in time-to-first-token on a self-hosted backend, so
      // these trade recall for latency. No zod defaults here: only what the
      // user set reaches the generated (and ejected) endpoint, so omitted
      // fields keep tracking the installed package's built-in defaults in
      // `ai/ask-context.ts` instead of pinning today's numbers as literals.
      retrieval: z
        .strictObject({
          contextBudget: z.number().int().positive().optional(),
          excerptChars: z.number().int().positive().optional(),
          maxResults: z.number().int().positive().optional(),
        })
        .optional(),
      // Empty-state prompts shown before the first question. Each renders as a
      // clickable suggestion; `icon` is an optional Lucide name beside it.
      suggestions: z
        .array(
          z.strictObject({
            icon: iconName.optional(),
            label: z.string().min(1),
          })
        )
        .default([]),
    })
    .superRefine((value, ctx) => {
      // A generic OpenAI-compatible backend has no preset URL, so the user
      // must supply one; the named providers fall back to their preset.
      if (
        value.provider === "openai-compatible" &&
        !(value.baseUrl || value.endpoint)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'ai.ask.baseUrl is required when provider is "openai-compatible".',
          path: ["baseUrl"],
        });
      }
    })
    .optional(),
  /**
   * `llms.txt`/`llms-full.txt` emission. A bare boolean toggles it; the object
   * form adds `openapi: false` to keep generated API reference pages out of
   * both files (e.g. when the configured spec is example content) and
   * `details`, free-form Markdown placed after the summary — the llms.txt
   * spec's details block, where a site tells agents when to reach for it.
   */
  llmsTxt: z
    .union([z.boolean(), llmsTxtObjectSchema])
    .default(true)
    .transform(
      (value): LlmsTxtResolved =>
        isBoolean(value) ? { enabled: value, openapi: true } : value
    ),
  // Serializers for the agent-facing Markdown downlevel (the `.md` mirror,
  // llms-full.txt, MCP get_page), keyed by JSX name. Functions live here —
  // not in components.tsx — because the config file is executed at build
  // time while the components file is only statically analyzed. A same-name
  // entry replaces the built-in serializer.
  // Two-argument `z.record` — the single-argument form throws at
  // schema-construction time under Zod 4 (see uiStringsOverrideSchema).
  markdownComponents: z
    .record(
      z.string(),
      z.custom<ComponentMarkdown>(
        (value): value is ComponentMarkdown => typeof value === "function",
        {
          message: "Expected a serializer function.",
        }
      )
    )
    .default({}),
  /** Expose the docs as an MCP server for connecting agents. */
  mcp: mcpConfigSchema.prefault({}),
  /**
   * The "Open in chat" page action. `true` (the default) lists every
   * provider, `false` hides the action entirely, and an array of provider
   * keys shows just that subset, in the given order. Normalized to the
   * provider list so consumers read a plain array.
   */
  openInChat: z
    .union([
      z.boolean(),
      z
        .array(z.enum(openInChatProviders))
        .refine((value) => new Set(value).size === value.length, {
          message: "ai.openInChat must not repeat a provider.",
        }),
    ])
    .default(true)
    .transform((value) => {
      if (isBoolean(value)) {
        return value ? [...openInChatProviders] : [];
      }
      return value;
    }),
  /**
   * Publish Agent Skills for discovery: a directory (resolved against the
   * project root) whose subdirectories each hold a `SKILL.md`. The build
   * copies each skill under `/.well-known/agent-skills/` — a lone `SKILL.md`
   * verbatim, a skill with supporting files as a `.tar.gz` — and emits the
   * discovery index (`index.json`) with SHA-256 digests per the Agent Skills
   * Discovery RFC.
   */
  skills: z.string().min(1).optional(),
  /**
   * Web Bot Auth (IETF `webbotauth`): publish the org's HTTP Message
   * Signature public keys at `/.well-known/http-message-signatures-directory`
   * so sites receiving requests from the org's agents can verify them.
   * Opt-in and public-keys-only — the private keys live wherever the signing
   * agents run, never in the site.
   */
  webBotAuth: z
    .strictObject({
      keys: z.array(publicJwkSchema).default([]),
    })
    .prefault({}),
  /**
   * WebMCP: register in-page tools (search, page Markdown, the docs index)
   * on the browser's model context so agentic browsers can drive the docs
   * without a separate MCP connection. A tiny script that no-ops in browsers
   * without the API; on by default.
   */
  webmcp: z.boolean().default(true),
});

/**
 * A pinned link rendered above the sidebar sections — a blog, changelog, or
 * contact page that should always be reachable, regardless of the active tab.
 * `href` may be an external URL or an internal route.
 */
const featuredLinkSchema = z.strictObject({
  href: z.string(),
  icon: iconName.optional(),
  label: z.string(),
});

const navigationConfigSchema = z.strictObject({
  /** Pinned links shown above the generated sidebar sections. */
  featured: z.array(featuredLinkSchema).default([]),
  /** Show a GitHub repo link in the header (requires `github` configured). */
  repo: z.boolean().default(true),
  selectors: z.array(navSelectorSchema).default([]),
  /**
   * Sidebar behavior. `display` sets how every group renders (a group in an
   * explicit `items` config may still override it); `items` is an explicit
   * sidebar — when omitted the sidebar is generated from the content tree.
   * A bare array is shorthand for `{ items }`.
   */
  sidebar: z
    .union([
      z.array(sidebarItemSchema),
      z.strictObject({
        display: sidebarDisplaySchema.default("flat"),
        items: z.array(sidebarItemSchema).optional(),
      }),
    ])
    .prefault({})
    .transform((value) =>
      Array.isArray(value) ? { display: "flat" as const, items: value } : value
    ),
  tabs: z.array(navTabSchema).default([]),
});

export type AskAiProvider = (typeof askAiProviders)[number];
export type AskAiConfig = NonNullable<z.infer<typeof aiConfigSchema>["ask"]>;
export { openInChatProviders } from "./open-in-chat.ts";
export type { OpenInChatProvider } from "./open-in-chat.ts";

// Reader-facing "Export" page action (PDF via print, EPUB via client-side
// generation). Off by default. Accepts a shorthand boolean to toggle both
// formats, or an object to enable them individually; both normalize to
// `{ epub, pdf }` so consumers read plain booleans.
const exportConfigSchema = z
  .union([
    z.boolean(),
    z.strictObject({
      epub: z.boolean().default(false),
      pdf: z.boolean().default(false),
    }),
  ])
  .transform((value) =>
    isBoolean(value) ? { epub: value, pdf: value } : value
  );

/** A configured locale: ISO-ish code plus display metadata for the switcher. */
const localeSchema = z.strictObject({
  code: z.string().min(1),
  /** Text direction; drives `<html dir>` and a future RTL pass. */
  dir: z.enum(["ltr", "rtl"]).default("ltr"),
  label: z.string(),
  /**
   * Freeform style guidance for `blume translate`, e.g. "Brazilian
   * Portuguese, informal você". Pins register and dialect from the first
   * translation and wins over an existing translation's style on reruns.
   */
  style: z.string().optional(),
});

/**
 * Internationalization. Opt-in: when absent, Blume is single-locale and behaves
 * exactly as before. The default locale lives at the content root; other locales
 * are top-level directories named by `code` (the `dir` parser).
 */
const i18nConfigSchema = z
  .strictObject({
    defaultLocale: z.string().default("en"),
    /** Locale rendered for a missing translation; `null` disables fallback. */
    fallbackLocale: z.string().nullable().optional(),
    /** Drop the URL prefix for the default locale (`/`, `/fr/…`). Static-safe. */
    hideDefaultLocalePrefix: z.boolean().default(true),
    locales: z.array(localeSchema).min(1),
    /** `"dir"`: locale directories (`fr/page.mdx`). `"dot"`: filename suffix (`page.fr.mdx`). */
    parser: z.enum(["dir", "dot"]).default("dir"),
    /** Per-locale UI string overrides: `{ fr: { search: { button: "…" } } }`. */
    ui: uiLocaleOverridesSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const codes = new Set(value.locales.map((locale) => locale.code));
    if (!codes.has(value.defaultLocale)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `i18n.defaultLocale "${value.defaultLocale}" must match one of i18n.locales.`,
        path: ["defaultLocale"],
      });
    }
    if (
      value.fallbackLocale !== null &&
      value.fallbackLocale !== undefined &&
      !codes.has(value.fallbackLocale)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `i18n.fallbackLocale "${value.fallbackLocale}" must match one of i18n.locales.`,
        path: ["fallbackLocale"],
      });
    }
  });

/**
 * Version ids must start with a letter (`v1.0`, not `1.0`): the id doubles as
 * the snapshot directory name, and a leading digit would collide with the
 * numeric-prefix ordering convention (`01-intro.mdx`), which strips `1.0/` to
 * `0/`. The rest allows word characters, dots, and hyphens — URL-safe as-is.
 */
export const VERSION_ID = /^[A-Za-z][\w.-]*$/u;

/** A frozen documentation snapshot: a directory under the content root. */
const archivedVersionSchema = z.strictObject({
  /**
   * The "you're viewing an old version" notice: `true` for the built-in
   * message, a string for custom copy, `false` to hide it.
   */
  banner: z.union([z.boolean(), z.string()]).default(true),
  /**
   * Where this version's pages point their canonical URL: `latest` targets the
   * same page in the current docs when it still exists (self otherwise), so
   * search engines treat the live page as authoritative without deindexing
   * version-only content. `self` keeps every page authoritative.
   */
  canonical: z.enum(["latest", "self"]).default("latest"),
  /** Directory name under the content root, and the URL segment. */
  id: z
    .string()
    .regex(
      VERSION_ID,
      'Version ids must start with a letter (e.g. "v1.0") and contain only letters, digits, dots, hyphens, and underscores.'
    ),
  /** Switcher label; defaults to the id. */
  label: z.string().optional(),
  /** Emit `noindex` on every page of this version. */
  noindex: z.boolean().default(false),
});

/**
 * Docs versioning. Opt-in: the latest docs live at the content root with
 * unprefixed URLs, and each archived version is a frozen snapshot directory
 * (`content/docs/<id>/`) cut with `blume version <id>`. Archived means frozen:
 * snapshots carry their own translations and are never retranslated.
 */
const versionsConfigSchema = z
  .strictObject({
    /** Frozen snapshots, newest first — this order is the switcher order. */
    archived: z.array(archivedVersionSchema).default([]),
    /** Labels the unprefixed tree (the latest docs) in the switcher. */
    current: z.strictObject({
      /** Small tag rendered next to the label (e.g. `Latest`). */
      badge: z.string().optional(),
      label: z.string(),
    }),
    switcher: z
      .strictObject({
        /**
         * Where switching lands when the page has no equivalent in the target
         * version: `same-page` goes to the equivalent when it exists (version
         * root otherwise); `root` always goes to the version root.
         */
        redirect: z.enum(["same-page", "root"]).default("same-page"),
      })
      .prefault({}),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [position, version] of value.archived.entries()) {
      if (seen.has(version.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `versions.archived declares "${version.id}" more than once.`,
          path: ["archived", position, "id"],
        });
      }
      seen.add(version.id);
    }
  });

const analyticsScriptSchema = z
  .strictObject({
    // Extra attributes (e.g. `data-domain`, `id`) spread onto the <script>.
    attributes: z.record(z.string(), z.string()).optional(),
    // Inline script body, mutually exclusive with `src`.
    content: z.string().optional(),
    // External script URL, mutually exclusive with `content`.
    src: z.string().optional(),
    // Load strategy for an external script.
    strategy: z.enum(["async", "defer"]).optional(),
  })
  .refine((value) => Boolean(value.src) !== Boolean(value.content), {
    message: "An analytics script must set exactly one of `src` or `content`.",
  });

const analyticsConfigSchema = z.strictObject({
  posthog: z
    .strictObject({
      host: z.string().optional(),
      key: z.string(),
    })
    .optional(),
  // Escape hatch for any other provider (Plausible, Fathom, GA, Umami, …).
  scripts: z.array(analyticsScriptSchema).optional(),
  vercel: z.boolean().optional(),
});

const deploymentConfigSchema = z.strictObject({
  adapter: z
    .enum(["vercel", "node", "netlify", "cloudflare"])
    .nullable()
    .default(null),
  base: z.string().optional(),
  output: z.enum(["static", "server"]).default("static"),
  site: z.url().optional(),
});

const redirectSchema = z.strictObject({
  from: z.string(),
  status: z
    .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
    .default(301),
  to: z.string(),
});

/**
 * One authorized remote image source, passed through to Astro's
 * `image.remotePatterns`. Wildcards follow Astro's rules: `hostname` accepts
 * `**.example.com` (any depth) or `*.example.com` (one level), `pathname`
 * accepts `/dir/**` or `/dir/*` the same way.
 */
const imageRemotePatternSchema = z.strictObject({
  hostname: z.string().optional(),
  pathname: z.string().optional(),
  port: z.string().optional(),
  protocol: z.string().optional(),
});

/**
 * Image optimization (`image`). Local images referenced by relative path
 * (`![alt](./diagram.png)`) are optimized at build time automatically —
 * compressed, converted to WebP, and stamped with intrinsic dimensions.
 * Remote images are only optimized when their host is authorized here;
 * both fields map directly onto Astro's `image` config.
 */
const imageConfigSchema = z.strictObject({
  /** Hosts whose remote images may be optimized, e.g. `["cdn.example.com"]`. */
  domains: z.array(z.string()).default([]),
  /** Pattern-based host authorization, for wildcards `domains` can't express. */
  remotePatterns: z.array(imageRemotePatternSchema).default([]),
});

/**
 * X (Twitter) attribution. The account fields feed `twitter:site` (the site's
 * account) and `twitter:creator` (the author's), which is the one piece of X
 * card metadata with no Open Graph equivalent to fall back to — everything else
 * on the card is read from `og:*`.
 */
const xConfigSchema = z.strictObject({
  /** The author's account, overridable per page via `seo.x.creator`. */
  creator: xHandleSchema,
  /** The site's own account, e.g. `@blume`. */
  handle: xHandleSchema,
});

/**
 * Any CSS color. Takumi parses the full grammar, so this stays unvalidated
 * here and a bad value fails the OG prerender with a parse error naming it —
 * the same fail-fast the card's accent relies on. Validating hex-only here
 * would reject `oklch(…)`, which `theme.accent` (the card's default accent)
 * already accepts.
 */
const ogColorSchema = z.string();

const ogPaletteSchema = z.strictObject({
  accent: ogColorSchema.optional(),
  background: ogColorSchema.optional(),
  border: ogColorSchema.optional(),
  foreground: ogColorSchema.optional(),
  muted: ogColorSchema.optional(),
});

/**
 * A font to load into the OG card renderer. A bare string is a Google Fonts
 * family name; the name-only object form pins the weight (a number, a list, or
 * a variable range like `"100..900"`) and style, fetched from Google Fonts at
 * build. The `src` form reads a local font file from the project instead.
 * Either way Takumi does per-glyph fallback, so a family covering a script
 * (e.g. Noto Sans JP for CJK) fixes tofu without touching how Latin renders.
 */
const ogFontWeightSchema = z.union([
  z.number().int().positive(),
  z.array(z.number().int().positive()),
  z.string().regex(/^\d+\.\.\d+$/u),
]);
const ogFontStyleSchema = z.enum(["normal", "italic"]);
const ogFontSchema = z.union([
  z.string(),
  z.strictObject({
    name: z.string(),
    style: z.union([ogFontStyleSchema, z.array(ogFontStyleSchema)]).optional(),
    weight: ogFontWeightSchema.optional(),
  }),
  /** A local font file, read from the project at build. */
  z.strictObject({
    name: z.string(),
    src: z.string().min(1),
    style: ogFontStyleSchema.optional(),
    weight: z.number().int().positive().optional(),
  }),
]);

const ogConfigSchema = z.strictObject({
  /**
   * Card subtitle. Defaults to the site description; a string overrides it,
   * `false` renders the card without one.
   */
  description: z.union([z.string(), z.literal(false)]).optional(),
  /**
   * Generate a per-page Open Graph image. Defaults to on once a deployment
   * site URL is known (set or auto-detected) and off otherwise, since
   * `og:image` must be absolute to be useful to crawlers — resolved in
   * `loadConfig`. An explicit value here always wins.
   */
  enabled: z.boolean().optional(),
  /**
   * Google Font families for the generated card, extending Takumi's Latin-only
   * default so non-Latin titles (CJK, and so on) render instead of tofu.
   * Fetched from Google Fonts at build.
   */
  fonts: z.array(ogFontSchema).optional(),
  /**
   * Local SVG used in the generated card instead of the site logo; `false`
   * renders the card without any brand mark.
   */
  logo: z.union([z.string(), z.literal(false)]).optional(),
  /** Optional generated-card colors. */
  palette: ogPaletteSchema.optional(),
  /**
   * Footer site text. Defaults to the deployment site's host plus
   * `deployment.base` (`docs.acme.com`, `user.github.io/repo`); a string
   * overrides it, `false` hides it.
   */
  site: z.union([z.string(), z.literal(false)]).optional(),
  /**
   * Card headlines for custom `.astro` pages, keyed by route (`"/"`, `"/cli"`).
   * A custom page has no frontmatter to read, so its card is otherwise titled
   * by humanizing its last URL segment (`/cli` → "Cli"); an entry here wins.
   * Content pages always take their card headline from the page title.
   */
  titles: z.record(z.string(), z.string()).optional(),
});

const rssConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Max items per feed, newest first. */
  limit: z.number().int().positive().default(50),
  /** Content types that each get a feed at `/<type>/rss.xml`. */
  types: z.array(z.string()).default(["blog", "changelog"]),
});

/**
 * robots.txt `Content-Signal` preferences — the emerging content-usage
 * declaration for how crawlers may reuse the site. Each field maps to one
 * signal:
 * - `search` → `search` (traditional and AI search indexing)
 * - `aiInput` → `ai-input` (grounding / RAG use at answer time)
 * - `aiTrain` → `ai-train` (model training)
 */
const contentSignalsObjectSchema = z.strictObject({
  aiInput: z.boolean().default(true),
  aiTrain: z.boolean().default(true),
  search: z.boolean().default(true),
});

/**
 * Content signals accept a boolean shorthand or a per-signal object, and
 * normalize to `{ search, aiInput, aiTrain }` — or `null` when disabled, so
 * robots.txt omits the declaration entirely. On by default (`true`): Blume
 * declares the docs open to search and agents. `false` opts out; an object
 * restricts individual signals (unset signals stay `yes`).
 */
const contentSignalsSchema = z
  .union([z.boolean(), contentSignalsObjectSchema])
  .transform((value) => {
    if (value === true) {
      return contentSignalsObjectSchema.parse({});
    }
    if (value === false) {
      return null;
    }
    return value;
  });

/** A schema.org `PostalAddress`, any part of which may be given. */
const postalAddressSchema = z.strictObject({
  addressCountry: z.string().optional(),
  addressLocality: z.string().optional(),
  addressRegion: z.string().optional(),
  postalCode: z.string().optional(),
  streetAddress: z.string().optional(),
});

/**
 * `seo.organization`: the organization behind the site, emitted on every page
 * as a schema.org `Organization` node (see `seo/jsonld.ts`). Name and URL
 * default to the site's; contact details become a `ContactPoint`, the address
 * a `PostalAddress` — what agents check to verify a business.
 */
const organizationConfigSchema = z.strictObject({
  address: postalAddressSchema.optional(),
  contactType: z.string().default("customer support"),
  email: z.email().optional(),
  logo: z.string().optional(),
  name: z.string().optional(),
  sameAs: z.array(z.url()).default([]),
  telephone: z.string().optional(),
  url: z.url().optional(),
});

/**
 * `seo.software`: the product the site documents, emitted on the homepage as
 * a schema.org `SoftwareApplication` node. `true` takes every default (name
 * and description from the site, category `DeveloperApplication`).
 */
const softwareConfigSchema = z.strictObject({
  applicationCategory: z.string().default("DeveloperApplication"),
  description: z.string().optional(),
  license: z.string().optional(),
  name: z.string().optional(),
  operatingSystem: z.string().optional(),
  price: z.union([z.number().nonnegative(), z.string()]).optional(),
  priceCurrency: z.string().default("USD"),
  sameAs: z.array(z.url()).default([]),
});

type SoftwareResolved = z.output<typeof softwareConfigSchema>;

/** Discoverability features: OG images, feeds, sitemap, structured data. */
const seoConfigSchema = z.strictObject({
  /**
   * Emit `agent-readability.json` at the site root: a manifest that indexes
   * the agent-facing surface (llms.txt, Markdown mirrors, MCP server, feeds)
   * so agents can discover it without scraping HTML.
   */
  agentReadability: z.boolean().default(true),
  /** robots.txt `Content-Signal` usage declaration (on by default). */
  contentSignals: contentSignalsSchema.prefault(true),
  og: ogConfigSchema.default({}),
  /** The organization behind the site, as an `Organization` JSON-LD node. */
  organization: organizationConfigSchema.optional(),
  /** Generate robots.txt (with a Sitemap reference when available). */
  robots: z.boolean().default(true),
  rss: rssConfigSchema.prefault({}),
  /** Generate sitemap.xml (requires deployment.site). */
  sitemap: z.boolean().default(true),
  /** The documented product, as a homepage `SoftwareApplication` node. */
  software: z
    .union([z.boolean(), softwareConfigSchema])
    .optional()
    .transform((value): SoftwareResolved | undefined => {
      if (value === true) {
        return softwareConfigSchema.parse({});
      }
      return value === false ? undefined : value;
    }),
  /** Emit schema.org JSON-LD in each page's <head>. */
  structuredData: z.boolean().default(true),
  /** X (Twitter) account attribution for share cards. */
  x: xConfigSchema.default({}),
});

const githubConfigSchema = z.strictObject({
  branch: z.string().default("main"),
  /** Path from the repo root to the project root (for monorepos). */
  dir: z.string().optional(),
  owner: z.string(),
  repo: z.string(),
});

/** The theme fields the structural code-theme check inspects. */
interface CodeThemeFields {
  colors?: unknown;
  settings?: unknown;
  tokenColors?: unknown;
}

/** A non-null, non-array object — the floor for a theme and its `colors` map. */
const isThemeObject = <Value>(value: Value): value is Value & CodeThemeFields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const codeThemeSchema = z.custom<CodeTheme>((value) => {
  if (isString(value)) {
    return true;
  }
  if (!isThemeObject(value)) {
    return false;
  }
  // Token rules live in `settings` (Shiki's canonical field, also the TextMate
  // form themes like createCssVariablesTheme() produce) or `tokenColors` (the
  // VS Code spelling Shiki falls back to). A colors-only theme (editor fg/bg,
  // no token rules) is also valid — Shiki renders it from `colors` alone. Each
  // field present must have the right shape, and at least one must be present.
  const settingsValid =
    value.settings === undefined || Array.isArray(value.settings);
  const tokenColorsValid =
    value.tokenColors === undefined || Array.isArray(value.tokenColors);
  const colorsValid = value.colors === undefined || isThemeObject(value.colors);
  const hasContent =
    value.settings !== undefined ||
    value.tokenColors !== undefined ||
    value.colors !== undefined;
  return settingsValid && tokenColorsValid && colorsValid && hasContent;
}, "Expected a Shiki theme name or custom theme object");

const codeBlockThemeSchema = z.strictObject({
  dark: codeThemeSchema.default("github-dark"),
  light: codeThemeSchema.default("github-light"),
});

const codeBlocksConfigSchema = z.strictObject({
  theme: codeBlockThemeSchema.prefault({}),
});

/**
 * `<Component />` example previews. A string is shorthand for `{ source }`:
 * where examples live, relative to the project root (default `examples`).
 * `source` may be a glob (anything with `*`/`?`/`[]`/`{}`/`!`), in which case
 * only matching files are discovered and each `<Component path>` key is
 * relative to the glob's static prefix — use this for a registry layout that
 * colocates component sources with their examples
 * (`registry/<pkg>/**\/examples/*`), leaving the sources (which have no
 * default export to wrap) out.
 *
 * `css` names a stylesheet (relative to the project root) injected into every
 * preview frame after Blume's default tokens. Previews render in an isolated
 * iframe that the site's docs styles never reach, so this is where design
 * tokens for the previewed components live — e.g. shadcn variables and
 * `@theme` mappings. Tailwind itself is already provided; the file should
 * hold tokens and custom styles, not another `@import "tailwindcss"`.
 */
const examplesConfigSchema = z
  .union([
    z.string(),
    z.strictObject({
      css: z.string().optional(),
      source: z.string().default("examples"),
    }),
  ])
  .transform((value): { css?: string; source: string } =>
    isString(value) ? { source: value } : value
  );

/**
 * "Last updated" timestamps for content pages. `false` (default) disables the
 * feature; `true` derives each page's date from git history; an object selects
 * the source explicitly. A page's `lastModified` frontmatter always wins.
 */
const lastModifiedConfigSchema = z.union([
  z.boolean(),
  z.strictObject({ type: z.enum(["git", "frontmatter"]).default("git") }),
]);

/**
 * How the "last updated" stamp and the changelog timeline render their dates —
 * a curated pass-through to `Intl.DateTimeFormat`, shared by both surfaces so
 * they read alike. Defaults to `{ dateStyle: "long" }`. Both stamps format in
 * UTC unless a `timeZone` is given, so a date reads the same regardless of the
 * build machine's zone. `dateStyle` is a preset that can't be combined with the
 * individual component fields (`year`, `month`, …), matching `Intl`'s own rule.
 */
const dateFormatConfigSchema = z
  .strictObject({
    /** Calendar system (e.g. `japanese`, `buddhist`). */
    calendar: z.string().optional(),
    /** Preset date length; mutually exclusive with the component fields. */
    dateStyle: z.enum(["full", "long", "medium", "short"]).optional(),
    /** Day representation. */
    day: z.enum(["numeric", "2-digit"]).optional(),
    /** Era representation (e.g. the Japanese imperial era). */
    era: z.enum(["long", "short", "narrow"]).optional(),
    /** Month representation. */
    month: z.enum(["numeric", "2-digit", "long", "short", "narrow"]).optional(),
    /** Numbering system (e.g. `latn`, `arab`). */
    numberingSystem: z.string().optional(),
    /** IANA time zone (e.g. `Asia/Tokyo`). Defaults to `UTC`. */
    timeZone: z.string().optional(),
    /** Weekday representation. */
    weekday: z.enum(["long", "short", "narrow"]).optional(),
    /** Year representation. */
    year: z.enum(["numeric", "2-digit"]).optional(),
  })
  .refine(
    (value) =>
      value.dateStyle === undefined ||
      (value.weekday === undefined &&
        value.era === undefined &&
        value.year === undefined &&
        value.month === undefined &&
        value.day === undefined),
    {
      message:
        "dateFormat.dateStyle can't be combined with weekday/era/year/month/day; use one or the other.",
    }
  );

/** Code-block rendering options (`markdown.code`). */
const codeConfigSchema = z.strictObject({
  /**
   * Show a brand language icon in the code-block header (TypeScript, Python,
   * …). On by default; recognized languages only.
   */
  icons: z.boolean().default(true),
  /**
   * Wrap long lines instead of scrolling horizontally. Off by default, so
   * code keeps its original line breaks and overflows into a scroll area.
   */
  wrap: z.boolean().default(false),
});

const markdownConfigSchema = z.strictObject({
  /** Code-block rendering: language icons and line wrapping. */
  code: codeConfigSchema.prefault({}),
  codeBlocks: codeBlocksConfigSchema.prefault({}),
  /**
   * Wrap each `##`–`######` heading in a link to its own anchor so readers can
   * click to copy, bookmark, or share a permalink to that section. On by
   * default; set to `false` to render plain headings.
   */
  headingAnchors: z.boolean().default(true),
  /**
   * Make content images click-to-zoom (open in a lightbox). On by default;
   * opt a single image out with `data-no-zoom`.
   */
  imageZoom: z.boolean().default(true),
});

/** React island behavior (`react`). */
const reactConfigSchema = z.strictObject({
  /**
   * Auto-memoize React components/hooks with the React Compiler
   * (`babel-plugin-react-compiler`). On by default whenever React is enabled
   * (a project `.tsx`/`.jsx`, a React island/example/override, or Ask AI); set
   * to `false` to skip the compiler's babel pass.
   */
  compiler: z.boolean().default(true),
});

/**
 * A single spec rendered by the API reference. `spec` is a local path or an
 * `http(s)` URL (an OpenAPI document under `openapi`, an AsyncAPI document
 * under `asyncapi`).
 */
const openapiSourceSchema = z.strictObject({
  /** Include generated pages from this spec in llms.txt/llms-full.txt. */
  includeInLlms: z.boolean().default(true),
  /** Include generated pages from this spec in site search. */
  includeInSearch: z.boolean().default(true),
  /** Nav/section label for this source. */
  label: z.string().optional(),
  /** Emit noindex metadata and omit generated pages from the sitemap. */
  noindex: z.boolean().default(false),
  /** Per-source route; defaults to the block's `route` (or a derived path). */
  route: z.string().optional(),
  /** Local path or `http(s)` URL to the spec. */
  spec: z.string(),
});

export type OpenApiSource = z.input<typeof openapiSourceSchema>;

/**
 * Arbitrary Scalar API-reference options forwarded verbatim to the generated
 * `<ScalarComponent>` (Scalar renderer only). A passthrough map — Blume doesn't
 * mirror Scalar's full config surface — so keys like `localization`, `agent`,
 * `hideTestRequestButton`, or `orderSchemaPropertiesBy` all flow through. These
 * take precedence over Blume's own derived config (spec, theme), so this is a
 * full escape hatch; the dedicated `theme` field is the ergonomic shorthand.
 */
const scalarConfigSchema = z.record(z.string(), z.unknown()).optional();

/**
 * The interactive "Try it" panel on operation pages (Blume renderer). On by
 * default; `false` hides it. The object form keeps it on and sets `proxy`,
 * the CORS escape hatch the Send button routes requests through: a proxy URL,
 * or `true` for the built-in `/_api-proxy` endpoint (which requires
 * `deployment.output: "server"`). Booleans normalize to the object shape so
 * consumers read `{ enabled, proxy }` directly. `proxy` applies to the
 * HTTP-posting playgrounds (OpenAPI, GraphQL) — an event composer's WebSocket
 * connect is direct. One schema for every reference block, so the
 * normalization can never drift between them.
 */
const playgroundConfigSchema = z
  .union([
    z.boolean(),
    z.strictObject({
      enabled: z.boolean().default(true),
      proxy: z.union([z.boolean(), z.string()]).default(false),
    }),
  ])
  .default(true)
  .transform((value) =>
    isBoolean(value) ? { enabled: value, proxy: false } : value
  );

/**
 * The shared shape of the API-reference blocks — only the mount route and
 * code-sample defaults differ per spec kind, so each block declares just
 * those (the GraphQL block derives from this via omit/extend below).
 */
const referenceConfigSchema = (defaults: {
  codeSamples: string[];
  route: string;
}) =>
  z.strictObject({
    /** Code-sample languages/tools shown per operation (Blume renderer). */
    codeSamples: z.array(z.string()).default(defaults.codeSamples),
    enabled: z.boolean().default(false),
    /** Start nested schema rows expanded rather than collapsed (Blume renderer). */
    expandSchemas: z.boolean().default(false),
    /** The "Try it" panel; see {@link playgroundConfigSchema}. */
    playground: playgroundConfigSchema,
    /** Who renders the reference: Blume's own UI, or the embedded Scalar SPA. */
    renderer: z.enum(["blume", "scalar"]).default("blume"),
    /** Where the reference mounts. */
    route: z.string().default(defaults.route),
    /** Extra Scalar config forwarded to `<ScalarComponent>` (Scalar renderer only). */
    scalar: scalarConfigSchema,
    /** One or more specs; each renders on its own route by default. */
    sources: z.array(openapiSourceSchema).default([]),
    /** Shorthand for a single source: `sources: [{ spec }]`. */
    spec: z.string().optional(),
    /** Scalar theme name (Scalar renderer only). */
    theme: z.string().optional(),
  });

/**
 * OpenAPI reference. By default (`renderer: "blume"`) Blume parses the spec with
 * Scalar's parser and renders its own UI: one real page per operation, grouped
 * by tag in the sidebar and included in site search, llms.txt, and OG. Set
 * `renderer: "scalar"` to fall back to the embedded Scalar SPA (a single
 * self-contained route that doesn't weave into the sidebar or search).
 */
const openapiConfigSchema = referenceConfigSchema({
  codeSamples: ["curl", "js", "python"],
  route: "/reference",
});

/**
 * AsyncAPI reference. Same shape as {@link openapiConfigSchema}: by default
 * (`renderer: "blume"`) Blume normalizes the spec to AsyncAPI 3.x and renders
 * its own UI — one real page per operation — with `renderer: "scalar"` as the
 * embedded-SPA opt-out. Only the defaults differ: the reference mounts at
 * `/events`, and empty `codeSamples` means every tool the operation's protocol
 * binding suggests.
 */
const asyncapiConfigSchema = referenceConfigSchema({
  codeSamples: [],
  route: "/events",
});

/**
 * A single GraphQL schema rendered by the reference. `spec` is a local path or
 * an `http(s)` URL to SDL text or an introspection JSON result; `endpoint` is
 * the live GraphQL API URL the playground and code samples target (a schema,
 * unlike an OpenAPI document, names no server).
 */
const graphqlSourceSchema = openapiSourceSchema.extend({
  /** URL of the live GraphQL endpoint (playground + code samples). */
  endpoint: z.string().optional(),
});

export type GraphqlSource = z.input<typeof graphqlSourceSchema>;

/**
 * GraphQL reference. Blume lowers the schema (SDL or introspection JSON) to
 * one real page per root field — grouped as Queries/Mutations/Subscriptions —
 * plus one page per named type (Objects, Input Objects, Enums, Interfaces,
 * Unions, Scalars), all included in the sidebar, search, llms.txt, and OG.
 * Always Blume-rendered: the Scalar SPA reads OpenAPI documents only, so the
 * block declares no `renderer`/`scalar`/`theme` escape hatches.
 */
const graphqlConfigSchema = referenceConfigSchema({
  codeSamples: ["curl", "js", "python"],
  route: "/graphql",
})
  // No `renderer`/`scalar`/`theme` escape hatches (the Scalar SPA reads
  // OpenAPI documents only) and no `expandSchemas` (GraphQL field tables have
  // no nesting) — everything else, the playground normalization included, is
  // the shared reference shape.
  .omit({ expandSchemas: true, renderer: true, scalar: true, theme: true })
  .extend({
    /** Default live endpoint URL for every source (per-source `endpoint` wins). */
    endpoint: z.string().optional(),
    /** One or more schemas; each renders on its own route by default. */
    sources: z.array(graphqlSourceSchema).default([]),
  });

/**
 * Opt-in custom frontmatter keys. `extend` maps each extra key a project's
 * pages may carry (e.g. `owner`, `reviewedAt`) to a validation schema; the
 * page schema stays strict for everything else, so typo-catching is preserved.
 * Schemas are consumed through the Standard Schema `~standard` contract —
 * never Zod's own API — so the consumer's zod (any version), Valibot, or
 * ArkType all work (see `standard-schema.ts`). Every declared key is validated
 * on every page, absent ones included, so a required schema enforces the key
 * site-wide; mark it `.optional()` to validate only when present. Built-in
 * frontmatter fields can't be redeclared — they're load-bearing (routing,
 * sidebar, SEO), and shadowing one would silently change its semantics.
 */
const frontmatterConfigSchema = z.strictObject({
  extend: customKeySchemaRecord("frontmatter.extend"),
});

/** Full user-facing config schema. All fields optional with defaults. */
/**
 * Table-of-contents config. `true`/`false` toggles it; an object narrows the
 * heading range. Normalized to `{ enabled, minLevel, maxLevel }` (default: on,
 * H2–H3, matching the historical hardcoded range).
 */
const tocConfigSchema = z
  .union([
    z.boolean(),
    z.strictObject({
      maxHeadingLevel: z.number().int().min(1).max(6).optional(),
      minHeadingLevel: z.number().int().min(1).max(6).optional(),
    }),
  ])
  .default(true)
  .transform((value) => {
    if (isBoolean(value)) {
      return { enabled: value, maxLevel: 3, minLevel: 2 };
    }
    return {
      enabled: true,
      maxLevel: value.maxHeadingLevel ?? 3,
      minLevel: value.minHeadingLevel ?? 2,
    };
  })
  // Checked after defaults apply, so `{ minHeadingLevel: 5 }` (default max 3)
  // is caught too — an inverted range would silently render an empty TOC.
  .refine((value) => value.minLevel <= value.maxLevel, {
    message:
      "toc.minHeadingLevel must be less than or equal to toc.maxHeadingLevel.",
  });

export const blumeConfigSchema = z
  .strictObject({
    ai: aiConfigSchema.prefault({}),
    analytics: analyticsConfigSchema.optional(),
    asyncapi: asyncapiConfigSchema.prefault({}),
    banner: bannerConfigSchema.optional(),
    /**
     * Site-wide mount point prepended to every generated route (e.g. `/docs`),
     * while staying invisible to the sidebar/nav tree. Distinct from a per-source
     * `prefix` (which creates a group) and from `deployment.base` (Astro's
     * host-subdirectory base); the two compose. Normalized to `""` or `/seg`.
     */
    basePath: z
      .string()
      .optional()
      .transform((value) => normalizeBasePath(value)),
    content: contentConfigSchema.prefault({}),
    /**
     * Date presentation for the "last updated" stamp and the changelog timeline.
     * Pass-through `Intl.DateTimeFormat` options; defaults to `{ dateStyle: "long" }`.
     */
    dateFormat: dateFormatConfigSchema.default({ dateStyle: "long" }),
    deployment: deploymentConfigSchema.prefault({}),
    description: z.string().optional(),
    /**
     * Where `<Component path>` resolves live previews and their source from.
     * A string is shorthand for `{ source }` — the directory (or glob, for
     * colocated registry layouts) under the project root that holds example
     * files. The object form adds `css`: a stylesheet injected into every
     * preview frame (design tokens, shadcn variables, `@theme` mappings).
     */
    examples: examplesConfigSchema.prefault("examples"),
    export: exportConfigSchema.prefault(false),
    feedback: z.boolean().default(true),
    /** Opt-in custom frontmatter keys, validated by user-supplied schemas. */
    frontmatter: frontmatterConfigSchema.prefault({}),
    github: githubConfigSchema.optional(),
    graphql: graphqlConfigSchema.prefault({}),
    i18n: i18nConfigSchema.optional(),
    image: imageConfigSchema.prefault({}),
    integrations: z.array(z.custom<AstroIntegration>()).default([]),
    lastModified: lastModifiedConfigSchema.default(false),
    logo: logoConfigSchema.optional(),
    markdown: markdownConfigSchema.prefault({}),
    navigation: navigationConfigSchema.prefault({}),
    openapi: openapiConfigSchema.prefault({}),
    react: reactConfigSchema.prefault({}),
    redirects: z.array(redirectSchema).default([]),
    search: searchConfigSchema.prefault({}),
    seo: seoConfigSchema.prefault({}),
    theme: themeConfigSchema.prefault({}),
    title: z.string().default("Documentation"),
    toc: tocConfigSchema,
    versions: versionsConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    // A version id that is also a configured locale code would make a leading
    // `<id>/` directory ambiguous between the two axes — refuse it outright so
    // detection order (version first, then locale) never has to guess.
    if (config.versions && config.i18n) {
      const localeCodes = new Set(
        config.i18n.locales.map((locale) => locale.code.toLowerCase())
      );
      for (const [position, version] of config.versions.archived.entries()) {
        if (localeCodes.has(version.id.toLowerCase())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Version id "${version.id}" is also a configured locale code — rename the version (e.g. "v${version.id}").`,
            path: ["versions", "archived", position, "id"],
          });
        }
      }
    }
    // A custom key is declared site-wide (`frontmatter.extend`) or per-type
    // (`content.types`), never both — two schemas for one key would make
    // precedence on pages of that type ambiguous.
    for (const [typeName, typeConfig] of Object.entries(config.content.types)) {
      for (const key of Object.keys(typeConfig.frontmatter)) {
        if (Object.hasOwn(config.frontmatter.extend, key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${key}" is already declared in frontmatter.extend and cannot be redeclared for type "${typeName}".`,
            path: ["content", "types", typeName, "frontmatter", key],
          });
        }
      }
      // A facet with no declared key could never carry a value — pages can't
      // even set the key — so it's a config mistake, caught here where both
      // the per-type map and the site-wide extend are visible.
      for (const [position, facet] of typeConfig.facets.entries()) {
        if (
          !(
            Object.hasOwn(typeConfig.frontmatter, facet) ||
            Object.hasOwn(config.frontmatter.extend, facet)
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Facet "${facet}" for type "${typeName}" is not a declared custom frontmatter key — add it to the type's frontmatter map or frontmatter.extend.`,
            path: ["content", "types", typeName, "facets", position],
          });
        }
      }
    }
  });

/** Resolved config: every field present after defaults are applied. */
export type ResolvedConfig = z.infer<typeof blumeConfigSchema>;
/** Resolved `dateFormat`: the `Intl.DateTimeFormat` options both date stamps share. */
export type ResolvedDateFormat = z.infer<typeof dateFormatConfigSchema>;
/** Resolved `frontmatter.extend`: custom key → user-supplied schema. */
export type FrontmatterExtend = Record<string, StandardSchema>;
/** Resolved i18n block (present only when the project opts into i18n). */
export type ResolvedI18nConfig = z.infer<typeof i18nConfigSchema>;
/** A configured locale with display metadata. */
export type LocaleConfig = z.infer<typeof localeSchema>;
/** Resolved versions block (present only when the project opts into versioning). */
export type ResolvedVersionsConfig = z.infer<typeof versionsConfigSchema>;
/** A configured archived (frozen) version. */
export type ArchivedVersionConfig = z.infer<typeof archivedVersionSchema>;
/**
 * User-authored config, straight off the schema. The public, hand-documented
 * authoring type is `BlumeConfig` in `./config-input.ts`, which a compile-time
 * guard keeps structurally identical to this.
 */
export type BlumeConfigInput = z.input<typeof blumeConfigSchema>;
/** A configured search backend. */
export type SearchProvider = (typeof searchProviders)[number];
/** Resolved robots.txt `Content-Signal` preferences (`null` when disabled). */
export type ContentSignals = z.infer<typeof contentSignalsSchema>;
/** The resolved per-signal policy object (present when signals are enabled). */
export type ContentSignalPolicy = NonNullable<ContentSignals>;
