import { z } from "zod";

import type { ComponentMarkdown } from "../ai/component-markdown.ts";
import { normalizeRoute } from "../openapi/references.ts";
import { normalizeXHandle } from "../seo/x-handle.ts";
import { FONT_SLUGS, isFontSlug } from "../theme/fonts.ts";
import { normalizeBasePath } from "./base-path.ts";
import { uiLocaleOverridesSchema } from "./i18n-ui.ts";
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

// ---------------------------------------------------------------------------
// Page frontmatter
// ---------------------------------------------------------------------------

const sidebarMetaSchema = z.strictObject({
  badge: z.string().optional(),
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
  // blume bundles Zod 3; top-level `z.url()` is undefined at runtime and
  // schemas must stay dual-compatible with consumer projects on Zod 4.
  // oxlint-disable-next-line react-doctor/zod-v4-prefer-top-level-string-formats
  canonical: z.string().url().optional(),
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

/** Frontmatter accepted on any content page. */
const pageMetaBaseSchema = z.strictObject({
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
  search: searchMetaSchema.default({}),
  seo: seoMetaSchema.default({}),
  sidebar: sidebarMetaSchema.default({}),
  slug: z.string().optional(),
  title: z.string().optional(),
  // No default: an absent `type` must fall through to `content.defaultType`.
  type: z.string().optional(),
});

export const pageMetaSchema = pageMetaBaseSchema;

export type PageMeta = z.infer<typeof pageMetaBaseSchema>;
export type PageMetaInput = z.input<typeof pageMetaBaseSchema>;

// ---------------------------------------------------------------------------
// Folder meta (meta.ts)
// ---------------------------------------------------------------------------

/**
 * How a sidebar group renders:
 * - `flat`: a non-collapsible header with its items listed beneath (default).
 * - `group`: a collapsible `<details>` disclosure.
 * - `page`: a single row that drills into a sub-panel showing only this group's
 *   items, with a back arrow at the top.
 */
const sidebarDisplaySchema = z.enum(["flat", "group", "page"]);
export type SidebarDisplay = z.infer<typeof sidebarDisplaySchema>;

export const folderMetaSchema = z.strictObject({
  collapsed: z.boolean().optional(),
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
    (val) =>
      typeof val === "object" &&
      val !== null &&
      typeof (val as { load?: unknown }).load === "function" &&
      typeof (val as { name?: unknown }).name === "string",
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
  customSourceSchema,
]);

/** A resolved content-source config entry (post-defaults). */
export type ContentSourceConfig = z.infer<typeof contentSourceSchema>;

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
});

const navTabSchema = z.strictObject({
  icon: iconName.optional(),
  items: z
    .array(
      z.strictObject({
        description: z.string().optional(),
        icon: iconName.optional(),
        label: z.string(),
        path: z.string(),
        tag: z.string().optional(),
      })
    )
    .optional(),
  label: z.string(),
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

const sidebarItemSchema: z.ZodType<SidebarItemConfig> = z.lazy(() =>
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

/** A curated Google Font slug (see `theme/fonts.ts`). */
const fontSlug = z.string().superRefine((value, ctx) => {
  if (!isFontSlug(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown font "${value}". Supported fonts: ${FONT_SLUGS.join(", ")}.`,
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
    typeof value === "string" ? { dark: value, light: value } : value
  );

const themeConfigSchema = z.strictObject({
  accent: z
    .union([
      z.string(),
      z.strictObject({ dark: z.string(), light: z.string() }),
    ])
    .default("blue")
    .transform((value) =>
      typeof value === "string" ? { dark: value, light: value } : value
    ),
  action: z.string().optional(),
  background: perModeValueSchema,
  backgroundImage: perModeValueSchema,
  fonts: z
    .strictObject({
      body: fontSlug.default("inter"),
      display: fontSlug.default("inter-tight"),
      mono: fontSlug.default("ibm-plex-mono"),
    })
    .default({}),
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
      .default({}),
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

const aiConfigSchema = z.strictObject({
  ask: z
    .strictObject({
      // Name of the env var holding the provider's API key; each provider has
      // a sensible default, so this only needs setting to override it.
      apiKeyEnv: z.string().optional(),
      // Base URL of the backend. Required for `openai-compatible`; for the
      // named providers it overrides the built-in preset.
      // blume bundles Zod 3; top-level `z.url()` is undefined at runtime.
      // oxlint-disable-next-line react-doctor/zod-v4-prefer-top-level-string-formats
      baseUrl: z.string().url().optional(),
      enabled: z.boolean().default(false),
      model: z.string().default("openai/gpt-5.5"),
      provider: z.enum(askAiProviders).default("gateway"),
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
      if (value.provider === "openai-compatible" && !value.baseUrl) {
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
   * both files (e.g. when the configured spec is example content).
   */
  llmsTxt: z
    .union([
      z.boolean(),
      z.strictObject({
        enabled: z.boolean().default(true),
        openapi: z.boolean().default(true),
      }),
    ])
    .default(true)
    .transform((value) =>
      typeof value === "boolean" ? { enabled: value, openapi: true } : value
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
      z.custom<ComponentMarkdown>((value) => typeof value === "function", {
        message: "Expected a serializer function.",
      })
    )
    .default({}),
  /** Expose the docs as an MCP server for connecting agents. */
  mcp: mcpConfigSchema.default({}),
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
    .default({})
    .transform((value) =>
      Array.isArray(value) ? { display: "flat" as const, items: value } : value
    ),
  tabs: z.array(navTabSchema).default([]),
});

export type AskAiProvider = (typeof askAiProviders)[number];
export type AskAiConfig = NonNullable<z.infer<typeof aiConfigSchema>["ask"]>;

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
    typeof value === "boolean" ? { epub: value, pdf: value } : value
  );

/** A configured locale: ISO-ish code plus display metadata for the switcher. */
const localeSchema = z.strictObject({
  code: z.string().min(1),
  /** Text direction; drives `<html dir>` and a future RTL pass. */
  dir: z.enum(["ltr", "rtl"]).default("ltr"),
  label: z.string(),
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
  // blume bundles Zod 3; top-level `z.url()` is undefined at runtime.
  // oxlint-disable-next-line react-doctor/zod-v4-prefer-top-level-string-formats
  site: z.string().url().optional(),
});

const redirectSchema = z.strictObject({
  from: z.string(),
  status: z
    .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
    .default(301),
  to: z.string(),
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
 * A Google Font family to load into the OG card renderer. A bare string is the
 * family name; the object form pins the weight (a number, a list, or a variable
 * range like `"100..900"`) and style. Fetched from Google Fonts at build and
 * handed to Takumi, which does per-glyph fallback so a family covering a script
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
]);

const ogConfigSchema = z.strictObject({
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
  /** Local SVG used in the generated card instead of the site logo. */
  logo: z.string().optional(),
  /** Optional generated-card colors. */
  palette: ogPaletteSchema.optional(),
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

/** Discoverability features: OG images, feeds, sitemap, structured data. */
const seoConfigSchema = z.strictObject({
  /**
   * Emit `agent-readability.json` at the site root: a manifest that indexes
   * the agent-facing surface (llms.txt, Markdown mirrors, MCP server, feeds)
   * so agents can discover it without scraping HTML.
   */
  agentReadability: z.boolean().default(true),
  /** robots.txt `Content-Signal` usage declaration (on by default). */
  contentSignals: contentSignalsSchema.default(true),
  og: ogConfigSchema.default({}),
  /** Generate robots.txt (with a Sitemap reference when available). */
  robots: z.boolean().default(true),
  rss: rssConfigSchema.default({}),
  /** Generate sitemap.xml (requires deployment.site). */
  sitemap: z.boolean().default(true),
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

const codeBlockThemeSchema = z.strictObject({
  dark: z.string().default("github-dark"),
  light: z.string().default("github-light"),
});

const codeBlocksConfigSchema = z.strictObject({
  theme: codeBlockThemeSchema.default({}),
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
    typeof value === "string" ? { source: value } : value
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
  code: codeConfigSchema.default({}),
  codeBlocks: codeBlocksConfigSchema.default({}),
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
 * `http(s)` URL (OpenAPI for the Blume renderer; OpenAPI or AsyncAPI for Scalar).
 */
const openapiSourceSchema = z.strictObject({
  /** Nav/section label for this source. */
  label: z.string().optional(),
  /** Per-source route; defaults to the block's `route` (or a derived path). */
  route: z.string().optional(),
  /** Local path or `http(s)` URL to the spec. */
  spec: z.string(),
});

export type OpenApiSource = z.infer<typeof openapiSourceSchema>;

/**
 * OpenAPI reference. By default (`renderer: "blume"`) Blume parses the spec with
 * Scalar's parser and renders its own UI: one real page per operation, grouped
 * by tag in the sidebar and included in site search, llms.txt, and OG. Set
 * `renderer: "scalar"` to fall back to the embedded Scalar SPA (a single
 * self-contained route that doesn't weave into the sidebar or search).
 */
const openapiConfigSchema = z.strictObject({
  /** Code-sample languages shown per operation (Blume renderer). */
  codeSamples: z.array(z.string()).default(["curl", "js", "python"]),
  enabled: z.boolean().default(false),
  /** Start nested schema rows expanded rather than collapsed (Blume renderer). */
  expandSchemas: z.boolean().default(false),
  /** Who renders the reference: Blume's own UI, or the embedded Scalar SPA. */
  renderer: z.enum(["blume", "scalar"]).default("blume"),
  /** Where the reference mounts. */
  route: z.string().default("/reference"),
  /** One or more specs; each renders on its own route by default. */
  sources: z.array(openapiSourceSchema).default([]),
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec: z.string().optional(),
  /** Scalar theme name (Scalar renderer only). */
  theme: z.string().optional(),
});

/**
 * AsyncAPI reference. Same shape and Scalar pipeline as {@link openapiConfigSchema}
 * (Scalar auto-detects the document type); only the default `route` differs.
 */
const asyncapiConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  route: z.string().default("/events"),
  sources: z.array(openapiSourceSchema).default([]),
  spec: z.string().optional(),
  theme: z.string().optional(),
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
  extend: z
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
        if (Object.hasOwn(pageMetaBaseSchema.shape, key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${key}" is a built-in frontmatter field and cannot be redeclared via frontmatter.extend.`,
            path: [key],
          });
        }
      }
    }),
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
    if (typeof value === "boolean") {
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

export const blumeConfigSchema = z.strictObject({
  ai: aiConfigSchema.default({}),
  analytics: analyticsConfigSchema.optional(),
  asyncapi: asyncapiConfigSchema.default({}),
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
  content: contentConfigSchema.default({}),
  deployment: deploymentConfigSchema.default({}),
  description: z.string().optional(),
  /**
   * Where `<Component path>` resolves live previews and their source from.
   * A string is shorthand for `{ source }` — the directory (or glob, for
   * colocated registry layouts) under the project root that holds example
   * files. The object form adds `css`: a stylesheet injected into every
   * preview frame (design tokens, shadcn variables, `@theme` mappings).
   */
  examples: examplesConfigSchema.default("examples"),
  export: exportConfigSchema.default(false),
  feedback: z.boolean().default(true),
  /** Opt-in custom frontmatter keys, validated by user-supplied schemas. */
  frontmatter: frontmatterConfigSchema.default({}),
  github: githubConfigSchema.optional(),
  i18n: i18nConfigSchema.optional(),
  lastModified: lastModifiedConfigSchema.default(false),
  logo: logoConfigSchema.optional(),
  markdown: markdownConfigSchema.default({}),
  navigation: navigationConfigSchema.default({}),
  openapi: openapiConfigSchema.default({}),
  react: reactConfigSchema.default({}),
  redirects: z.array(redirectSchema).default([]),
  search: searchConfigSchema.default({}),
  seo: seoConfigSchema.default({}),
  theme: themeConfigSchema.default({}),
  title: z.string().default("Documentation"),
  toc: tocConfigSchema,
});

/** Resolved config: every field present after defaults are applied. */
export type ResolvedConfig = z.infer<typeof blumeConfigSchema>;
/** Resolved `frontmatter.extend`: custom key → user-supplied schema. */
export type FrontmatterExtend = Record<string, StandardSchema>;
/** Resolved i18n block (present only when the project opts into i18n). */
export type ResolvedI18nConfig = z.infer<typeof i18nConfigSchema>;
/** A configured locale with display metadata. */
export type LocaleConfig = z.infer<typeof localeSchema>;
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
