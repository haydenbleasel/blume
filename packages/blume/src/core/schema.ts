import { z } from "zod";

import { FONT_SLUGS, isFontSlug } from "../theme/fonts.ts";
import { uiLocaleOverridesSchema } from "./i18n-ui.ts";
import type { ContentSource } from "./sources/types.ts";

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

const sidebarMetaSchema = z
  .object({
    badge: z.string().optional(),
    hidden: z.boolean().default(false),
    icon: iconName.optional(),
    label: z.string().optional(),
    order: z.number().optional(),
  })
  .strict();

const seoMetaSchema = z
  .object({
    canonical: z.string().url().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    noindex: z.boolean().default(false),
    title: z.string().optional(),
  })
  .strict();

const searchMetaSchema = z
  .object({
    boost: z.number().optional(),
    exclude: z.boolean().default(false),
    tags: z.array(z.string()).optional(),
  })
  .strict();

const changelogMetaSchema = z
  .object({
    category: z.string().optional(),
    date: dateSchema.optional(),
    version: z.string().optional(),
  })
  .strict();

/** Frontmatter accepted on any content page. */
const pageMetaBaseSchema = z
  .object({
    changelog: changelogMetaSchema.optional(),
    /** Publish date for feed-backed content like blog/changelog. */
    date: dateSchema.optional(),
    deprecated: z.boolean().default(false),
    description: z.string().optional(),
    draft: z.boolean().default(false),
    groups: z.union([z.string(), z.array(z.string())]).optional(),
    hidden: z.boolean().default(false),
    hideApiMarker: z.boolean().default(false),
    hideFooterPagination: z.boolean().optional(),
    icon: iconName.optional(),
    iconType: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    /** Overrides the git-derived last-modified date when `lastModified` is on. */
    lastModified: dateSchema.optional(),
    mode: z.string().optional(),
    noindex: z.boolean().default(false),
    public: z.boolean().optional(),
    rss: z.boolean().optional(),
    search: searchMetaSchema.default({}),
    seo: seoMetaSchema.default({}),
    sidebar: sidebarMetaSchema.default({}),
    sidebarTitle: z.string().optional(),
    slug: z.string().optional(),
    tag: z.string().optional(),
    title: z.string().optional(),
    type: z.string().default("doc"),
  })
  .strict();

export const pageMetaSchema = pageMetaBaseSchema;

export type PageMeta = z.infer<typeof pageMetaBaseSchema>;
export type PageMetaInput = z.input<typeof pageMetaBaseSchema>;

// ---------------------------------------------------------------------------
// Folder meta (meta.ts)
// ---------------------------------------------------------------------------

export const folderMetaSchema = z
  .object({
    collapsed: z.boolean().optional(),
    icon: iconName.optional(),
    order: z.number().optional(),
    /** Explicit child ordering by slug segment (without numeric prefix). */
    pages: z.array(z.string()).optional(),
    title: z.string().optional(),
  })
  .strict();

export type FolderMeta = z.infer<typeof folderMetaSchema>;

// ---------------------------------------------------------------------------
// Project config (blume.config.ts)
// ---------------------------------------------------------------------------

const logoConfigSchema = z.union([
  z.string(),
  z
    .object({
      alt: z.string().optional(),
      dark: z.string().optional(),
      href: z.string().optional(),
      light: z.string().optional(),
    })
    .strict(),
]);

const faviconConfigSchema = z.union([
  z.string(),
  z
    .object({
      dark: z.string().optional(),
      light: z.string().optional(),
    })
    .strict(),
]);

const bannerColorSchema = z
  .object({
    dark: z.string().optional(),
    light: z.string().optional(),
  })
  .strict()
  .refine((value) => value.dark !== undefined || value.light !== undefined, {
    message: "Banner color requires at least one of light or dark.",
  });

/** Site-wide announcement banner: a string, or text with an optional link. */
const bannerConfigSchema = z.union([
  z.string(),
  z
    .object({
      /** Background color override (Mintlify compatibility). */
      color: bannerColorSchema.optional(),
      content: z.string(),
      /** Show a dismiss button; the choice is remembered per visitor. */
      dismissible: z.boolean().default(false),
      /** Stable key for remembering dismissal; defaults to the content. */
      id: z.string().optional(),
      link: z
        .object({ href: z.string(), text: z.string() })
        .strict()
        .optional(),
      /** Tone (Mintlify compatibility). */
      type: z.enum(["info", "warning", "critical"]).optional(),
    })
    .strict(),
]);

/** A local filesystem content source. */
const filesystemSourceSchema = z
  .object({
    exclude: z.array(z.string()).default(["**/_*", "**/.*"]),
    include: z.array(z.string()).default(["**/*.{md,mdx}"]),
    /** Namespaces the source's routes under `/<prefix>/`. */
    prefix: z.string().optional(),
    root: z.string().default("docs"),
    type: z.literal("filesystem"),
  })
  .strict();

/**
 * Remote Markdown/MDX fetched over HTTP. Enumerate files either explicitly
 * (`files` against a raw `url` base) or from a GitHub repo subtree (`github`).
 * The token, when needed, comes from `GITHUB_TOKEN` — never inlined here.
 */
const mdxRemoteSourceSchema = z
  .object({
    /** Explicit list of source-relative file paths to fetch from `url`. */
    files: z.array(z.string()).optional(),
    /** Enumerate a GitHub repo subtree via the git-trees API. */
    github: z
      .object({
        owner: z.string(),
        path: z.string().default(""),
        ref: z.string().default("main"),
        repo: z.string(),
      })
      .strict()
      .optional(),
    /** Glob patterns applied to enumerated refs. */
    include: z.array(z.string()).default(["**/*.{md,mdx}"]),
    /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
    pollInterval: z.number().positive().optional(),
    /** Namespaces the source's routes under `/<prefix>/`. */
    prefix: z.string().optional(),
    type: z.literal("mdx-remote"),
    /** Raw base URL, e.g. `https://raw.githubusercontent.com/acme/sdk/main/docs`. */
    url: z.string().optional(),
  })
  .strict();

/** A Sanity dataset queried with GROQ; Portable Text bodies become Markdown. */
const sanitySourceSchema = z.object({
  /** Sanity API version (a date); default `2024-01-01`. */
  apiVersion: z.string().optional(),
  dataset: z.string(),
  /** Field paths mapping a document onto Blume meta + body. */
  fields: z
    .object({
      body: z.string().optional(),
      description: z.string().optional(),
      lastModified: z.string().optional(),
      slug: z.string().optional(),
      title: z.string().optional(),
    })
    .strict()
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
    .object({
      description: z.string().optional(),
      order: z.string().optional(),
      slug: z.string().optional(),
      status: z.string().optional(),
      title: z.string().optional(),
    })
    .strict()
    .optional(),
  /** Status value treated as published; others map to `draft`. Default `Published`. */
  publishedValue: z.string().optional(),
  type: z.literal("notion"),
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
  sanitySourceSchema,
  notionSourceSchema,
  customSourceSchema,
]);

/** A resolved content-source config entry (post-defaults). */
export type ContentSourceConfig = z.infer<typeof contentSourceSchema>;

const contentConfigSchema = z
  .object({
    defaultType: z.string().default("doc"),
    exclude: z.array(z.string()).default(["**/_*", "**/.*"]),
    include: z.array(z.string()).default(["**/*.{md,mdx}"]),
    pages: z.string().default("pages"),
    root: z.string().default("docs"),
    /**
     * Pluggable content sources. When omitted, the top-level
     * `root`/`include`/`exclude` desugar to one implicit filesystem source, so
     * existing projects are unchanged.
     */
    sources: z.array(contentSourceSchema).optional(),
  })
  .strict();

const navTabSchema = z
  .object({
    icon: iconName.optional(),
    items: z
      .array(
        z
          .object({
            description: z.string().optional(),
            icon: iconName.optional(),
            label: z.string(),
            path: z.string(),
            tag: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    label: z.string(),
    path: z.string(),
  })
  .strict();

const navSelectorItemSchema = z
  .object({
    description: z.string().optional(),
    icon: iconName.optional(),
    label: z.string(),
    path: z.string(),
    tag: z.string().optional(),
  })
  .strict();

const navSelectorSchema = z
  .object({
    items: z.array(navSelectorItemSchema).default([]),
    kind: z.enum(["dropdown", "language", "product", "version"]),
    label: z.string(),
  })
  .strict();

const directoryModeSchema = z.enum(["accordion", "card", "none"]);
export type DirectoryMode = z.infer<typeof directoryModeSchema>;

/** A node in an explicit sidebar config: a page reference or a group/link. */
export type SidebarItemConfig =
  | string
  | {
      label: string;
      badge?: string;
      directory?: DirectoryMode;
      href?: string;
      icon?: string;
      collapsed?: boolean;
      items?: SidebarItemConfig[];
      root?: string;
    };

const sidebarItemSchema: z.ZodType<SidebarItemConfig> = z.lazy(() =>
  z.union([
    z.string(),
    z
      .object({
        badge: z.string().optional(),
        collapsed: z.boolean().optional(),
        directory: directoryModeSchema.optional(),
        href: z.string().optional(),
        icon: iconName.optional(),
        items: z.array(sidebarItemSchema).optional(),
        label: z.string(),
        root: z.string().optional(),
      })
      .strict(),
  ])
);

const sidebarVariantSchema = z
  .object({
    items: z.array(sidebarItemSchema).default([]),
    path: z.string(),
  })
  .strict();

const navbarLinkTypeSchema = z.enum(["github", "discord"]);

const navbarLinkSchema = z
  .object({
    href: z.string(),
    icon: iconName.optional(),
    label: z.string().optional(),
    type: navbarLinkTypeSchema.optional(),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.type !== undefined, {
    message: "Navbar links require either label or type.",
  });

const navbarPrimarySchema = z
  .object({
    href: z.string(),
    label: z.string().optional(),
    type: z.enum(["button", "github", "discord"]).default("button"),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.type !== "button", {
    message: "Navbar primary button links require a label.",
  });

const navbarConfigSchema = z
  .object({
    links: z.array(navbarLinkSchema).default([]),
    primary: navbarPrimarySchema.optional(),
  })
  .strict();

const variablesConfigSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]+$/u), z.string())
  .default({});

/** A curated Google Font slug (see `theme/fonts.ts`). */
const fontSlug = z.string().refine(isFontSlug, (value) => ({
  message: `Unknown font "${value}". Supported fonts: ${FONT_SLUGS.join(", ")}.`,
}));

const themeConfigSchema = z
  .object({
    accent: z.string().default("blue"),
    accentDark: z.string().optional(),
    action: z.string().optional(),
    background: z.string().optional(),
    backgroundDark: z.string().optional(),
    backgroundDecoration: z.enum(["gradient", "grid", "windows"]).optional(),
    backgroundImage: z.string().optional(),
    backgroundImageDark: z.string().optional(),
    fonts: z
      .object({
        body: fontSlug.default("inter"),
        display: fontSlug.default("inter-tight"),
        mono: fontSlug.default("ibm-plex-mono"),
      })
      .strict()
      .default({}),
    layout: z.enum(["sidebar"]).default("sidebar"),
    mode: z.enum(["system", "light", "dark"]).default("system"),
    radius: z.enum(["none", "sm", "md", "lg"]).default("md"),
    strict: z.boolean().default(false),
  })
  .strict();

const iconsConfigSchema = z
  .object({
    library: z.enum(["fontawesome", "lucide", "tabler"]).default("lucide"),
  })
  .strict();

/** Public credentials for the Algolia search backend (sync key is an env var). */
const algoliaSearchSchema = z
  .object({
    appId: z.string(),
    indexName: z.string(),
    searchApiKey: z.string(),
  })
  .strict();

/** Public credentials for the Orama Cloud search backend. */
const oramaCloudSearchSchema = z
  .object({
    apiKey: z.string(),
    endpoint: z.string(),
    /** Index id used by the build-time sync (with `ORAMA_PRIVATE_API_KEY`). */
    indexId: z.string().optional(),
  })
  .strict();

/** Public credentials for a (self-hosted or cloud) Typesense backend. */
const typesenseSearchSchema = z
  .object({
    collection: z.string(),
    host: z.string(),
    port: z.number().int().positive().optional(),
    protocol: z.enum(["http", "https"]).optional(),
    searchApiKey: z.string(),
  })
  .strict();

/** Mixedbread semantic search: the store the server endpoint queries. */
const mixedbreadSearchSchema = z
  .object({
    storeId: z.string(),
  })
  .strict();

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

const searchConfigSchema = z
  .object({
    algolia: algoliaSearchSchema.optional(),
    indexing: z
      .object({
        includeHiddenPages: z.boolean().default(false),
      })
      .strict()
      .default({}),
    mixedbread: mixedbreadSearchSchema.optional(),
    oramaCloud: oramaCloudSearchSchema.optional(),
    prompt: z.string().optional(),
    provider: z.enum(searchProviders).default("orama"),
    typesense: typesenseSearchSchema.optional(),
  })
  .strict()
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

const aiConfigSchema = z
  .object({
    ask: z
      .object({
        // Name of the env var holding the provider's API key; each provider has
        // a sensible default, so this only needs setting to override it.
        apiKeyEnv: z.string().optional(),
        // Base URL of the backend. Required for `openai-compatible`; for the
        // named providers it overrides the built-in preset.
        baseUrl: z.string().url().optional(),
        enabled: z.boolean().default(false),
        model: z.string().default("openai/gpt-5.5"),
        provider: z.enum(askAiProviders).default("gateway"),
      })
      .strict()
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
    llmsTxt: z.boolean().default(false),
  })
  .strict();

const contextualOptionSchema = z.union([
  z.string(),
  z
    .object({
      description: z.string().optional(),
      href: z.string().optional(),
      icon: iconName.optional(),
      title: z.string(),
    })
    .passthrough(),
]);

const contextualConfigSchema = z
  .object({
    display: z.enum(["header", "toc"]).default("header"),
    options: z.array(contextualOptionSchema).default([]),
  })
  .strict();

const footerConfigSchema = z
  .object({
    links: z
      .array(
        z
          .object({
            header: z.string().optional(),
            items: z
              .array(
                z
                  .object({
                    href: z.string(),
                    label: z.string(),
                  })
                  .strict()
              )
              .default([]),
          })
          .strict()
      )
      .max(4)
      .default([]),
    socials: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const chromeVariantSchema = z
  .object({
    banner: bannerConfigSchema.optional(),
    footer: footerConfigSchema.optional(),
    navbar: navbarConfigSchema.optional(),
    path: z.string(),
  })
  .strict();

const navigationConfigSchema = z
  .object({
    chromeVariants: z.array(chromeVariantSchema).default([]),
    /** Show a GitHub repo link in the header (requires `github` configured). */
    repo: z.boolean().default(true),
    selectors: z.array(navSelectorSchema).default([]),
    /** Explicit sidebar override; when omitted the sidebar is generated. */
    sidebar: z.array(sidebarItemSchema).optional(),
    sidebarVariants: z.array(sidebarVariantSchema).default([]),
    tabs: z.array(navTabSchema).optional(),
  })
  .strict();

export type AskAiProvider = (typeof askAiProviders)[number];
export type AskAiConfig = NonNullable<z.infer<typeof aiConfigSchema>["ask"]>;

// Reader-facing "Export" page action (PDF via print, EPUB via client-side
// generation). Off by default. Accepts a shorthand boolean to toggle both
// formats, or an object to enable them individually; both normalize to
// `{ epub, pdf }` so consumers read plain booleans.
const exportConfigSchema = z
  .union([
    z.boolean(),
    z
      .object({
        epub: z.boolean().default(false),
        pdf: z.boolean().default(false),
      })
      .strict(),
  ])
  .transform((value) =>
    typeof value === "boolean" ? { epub: value, pdf: value } : value
  );

const mcpConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Optional system hint passed to connecting agents. */
    instructions: z.string().optional(),
    /** Server name shown to clients; defaults to the site title. */
    name: z.string().optional(),
    route: z.string().default("/mcp"),
  })
  .strict();

/** A configured locale: ISO-ish code plus display metadata for the switcher. */
const localeSchema = z
  .object({
    code: z.string().min(1),
    /** Text direction; drives `<html dir>` and a future RTL pass. */
    dir: z.enum(["ltr", "rtl"]).default("ltr"),
    label: z.string(),
  })
  .strict();

/**
 * Internationalization. Opt-in: when absent, Blume is single-locale and behaves
 * exactly as before. The default locale lives at the content root; other locales
 * are top-level directories named by `code` (the `dir` parser).
 */
const i18nConfigSchema = z
  .object({
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
  .strict()
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

const analyticsConfigSchema = z
  .object({
    posthog: z
      .object({
        host: z.string().optional(),
        key: z.string(),
      })
      .strict()
      .optional(),
    vercel: z.boolean().optional(),
  })
  .strict();

const deploymentConfigSchema = z
  .object({
    adapter: z
      .enum(["vercel", "node", "netlify", "cloudflare"])
      .nullable()
      .default(null),
    base: z.string().optional(),
    output: z.enum(["static", "server"]).default("static"),
    site: z.string().url().optional(),
  })
  .strict();

const redirectSchema = z
  .object({
    from: z.string(),
    status: z
      .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
      .default(301),
    to: z.string(),
  })
  .strict();

const ogConfigSchema = z
  .object({
    /**
     * Generate a per-page Open Graph image. Defaults to on once a deployment
     * site URL is known (set or auto-detected) and off otherwise, since
     * `og:image` must be absolute to be useful to crawlers — resolved in
     * `loadConfig`. An explicit value here always wins.
     */
    enabled: z.boolean().optional(),
  })
  .strict();

const rssConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Max items per feed, newest first. */
    limit: z.number().int().positive().default(50),
    /** Content types that each get a feed at `/<type>/rss.xml`. */
    types: z.array(z.string()).default(["blog", "changelog"]),
  })
  .strict();

/** Discoverability features: OG images, feeds, sitemap, structured data. */
const seoConfigSchema = z
  .object({
    metatags: z.record(z.string(), z.string()).default({}),
    og: ogConfigSchema.default({}),
    /** Generate robots.txt (with a Sitemap reference when available). */
    robots: z.boolean().default(true),
    rss: rssConfigSchema.default({}),
    /** Generate sitemap.xml (requires deployment.site). */
    sitemap: z.boolean().default(true),
    /** Emit schema.org JSON-LD in each page's <head>. */
    structuredData: z.boolean().default(true),
  })
  .strict();

const githubConfigSchema = z
  .object({
    branch: z.string().default("main"),
    /** Path from the repo root to the project root (for monorepos). */
    dir: z.string().optional(),
    owner: z.string(),
    repo: z.string(),
  })
  .strict();

const codeBlockThemeSchema = z
  .object({
    dark: z.string().default("github-dark"),
    light: z.string().default("github-light"),
  })
  .strict();

const codeBlocksConfigSchema = z
  .object({
    theme: codeBlockThemeSchema.default({}),
  })
  .strict();

/**
 * "Last updated" timestamps for content pages. `false` (default) disables the
 * feature; `true` derives each page's date from git history; an object selects
 * the source explicitly. A page's `lastModified` frontmatter always wins.
 */
const lastModifiedConfigSchema = z.union([
  z.boolean(),
  z.object({ type: z.enum(["git", "frontmatter"]).default("git") }).strict(),
]);

/** Code-block rendering options (`markdown.code`). */
const codeConfigSchema = z
  .object({
    /**
     * Show a brand language icon in the code-block header (TypeScript, Python,
     * …). On by default; recognized languages only.
     */
    icons: z.boolean().default(true),
    /**
     * Syntax-highlight inline `` `code{:lang}` `` snippets. Off by default — most
     * inline code (flags, file names) reads better plain; opt a snippet in with
     * a trailing `{:lang}` marker.
     */
    inline: z.boolean().default(false),
    /**
     * Wrap long lines instead of scrolling horizontally. Off by default, so
     * code keeps its original line breaks and overflows into a scroll area.
     */
    wrap: z.boolean().default(false),
  })
  .strict();

const markdownConfigSchema = z
  .object({
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
    /**
     * Enable LaTeX math (`$…$` inline, `$$…$$` block) rendered with KaTeX.
     * Off by default since `$` is common in prose, shell, and code. MDX only.
     */
    math: z.boolean().default(false),
  })
  .strict();

const stylingConfigSchema = z
  .object({
    eyebrows: z.enum(["breadcrumbs", "section"]).default("section"),
  })
  .strict();

/**
 * A single spec rendered by the API reference (Scalar). `spec` is a local path
 * or an `http(s)` URL; Scalar auto-detects OpenAPI vs AsyncAPI documents.
 */
const openapiSourceSchema = z
  .object({
    /** Nav/section label for this source. */
    label: z.string().optional(),
    /** Per-source route; defaults to the block's `route` (or a derived path). */
    route: z.string().optional(),
    /** Local path or `http(s)` URL to the spec. */
    spec: z.string(),
  })
  .strict();

export type OpenApiSource = z.infer<typeof openapiSourceSchema>;

/**
 * OpenAPI reference, delegated wholesale to Scalar (`@scalar/astro`). The
 * reference is a self-contained embed on its own route — it does not weave into
 * Blume's sidebar, search, or llms. Set `enabled: true` to opt in.
 */
const openapiConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Where the reference mounts. */
    route: z.string().default("/reference"),
    /** One or more specs; each renders on its own route by default. */
    sources: z.array(openapiSourceSchema).default([]),
    /** Shorthand for a single source: `sources: [{ spec }]`. */
    spec: z.string().optional(),
    /** Scalar theme name; defaults to a Blume-derived accent override. */
    theme: z.string().optional(),
  })
  .strict();

/**
 * AsyncAPI reference. Same shape and Scalar pipeline as {@link openapiConfigSchema}
 * (Scalar auto-detects the document type); only the default `route` differs.
 */
const asyncapiConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    route: z.string().default("/events"),
    sources: z.array(openapiSourceSchema).default([]),
    spec: z.string().optional(),
    theme: z.string().optional(),
  })
  .strict();

/** Full user-facing config schema. All fields optional with defaults. */
export const blumeConfigSchema = z
  .object({
    ai: aiConfigSchema.default({}),
    analytics: analyticsConfigSchema.optional(),
    asyncapi: asyncapiConfigSchema.default({}),
    banner: bannerConfigSchema.optional(),
    content: contentConfigSchema.default({}),
    contextual: contextualConfigSchema.default({}),
    deployment: deploymentConfigSchema.default({}),
    description: z.string().optional(),
    export: exportConfigSchema.default(false),
    favicon: faviconConfigSchema.optional(),
    footer: footerConfigSchema.default({}),
    github: githubConfigSchema.optional(),
    i18n: i18nConfigSchema.optional(),
    icons: iconsConfigSchema.default({}),
    lastModified: lastModifiedConfigSchema.default(false),
    logo: logoConfigSchema.optional(),
    markdown: markdownConfigSchema.default({}),
    mcp: mcpConfigSchema.default({}),
    navbar: navbarConfigSchema.default({}),
    navigation: navigationConfigSchema.default({}),
    openapi: openapiConfigSchema.default({}),
    redirects: z.array(redirectSchema).default([]),
    search: searchConfigSchema.default({}),
    seo: seoConfigSchema.default({}),
    styling: stylingConfigSchema.default({}),
    theme: themeConfigSchema.default({}),
    title: z.string().default("Documentation"),
    variables: variablesConfigSchema,
  })
  .strict();

/** Resolved config: every field present after defaults are applied. */
export type ResolvedConfig = z.infer<typeof blumeConfigSchema>;
/** Resolved i18n block (present only when the project opts into i18n). */
export type ResolvedI18nConfig = z.infer<typeof i18nConfigSchema>;
/** A configured locale with display metadata. */
export type LocaleConfig = z.infer<typeof localeSchema>;
/** User-authored config: the shape accepted by `defineConfig`. */
export type BlumeConfig = z.input<typeof blumeConfigSchema>;
/** A configured search backend. */
export type SearchProvider = (typeof searchProviders)[number];
