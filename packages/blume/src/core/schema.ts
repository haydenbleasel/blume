import { z } from "zod";

import { FONT_SLUGS, isFontSlug } from "../theme/fonts.ts";

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

const tocMetaSchema = z.union([
  z.boolean(),
  z
    .object({
      maxHeadingLevel: z.number().int().min(1).max(6).default(3),
      minHeadingLevel: z.number().int().min(1).max(6).default(2),
    })
    .strict(),
]);

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
export const pageMetaSchema = z
  .object({
    changelog: changelogMetaSchema.optional(),
    /** Publish date for feed-backed content like blog/changelog. */
    date: dateSchema.optional(),
    description: z.string().optional(),
    draft: z.boolean().default(false),
    /** Overrides the git-derived last-modified date when `lastModified` is on. */
    lastModified: dateSchema.optional(),
    search: searchMetaSchema.default({}),
    seo: seoMetaSchema.default({}),
    sidebar: sidebarMetaSchema.default({}),
    slug: z.string().optional(),
    title: z.string().optional(),
    toc: tocMetaSchema.default(true),
    type: z.string().default("doc"),
  })
  .strict();

export type PageMeta = z.infer<typeof pageMetaSchema>;
export type PageMetaInput = z.input<typeof pageMetaSchema>;

// ---------------------------------------------------------------------------
// Folder meta (_meta.json / _meta.yaml)
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

/** Site-wide announcement banner: a string, or text with an optional link. */
const bannerConfigSchema = z.union([
  z.string(),
  z
    .object({
      content: z.string(),
      /** Show a dismiss button; the choice is remembered per visitor. */
      dismissible: z.boolean().default(false),
      /** Stable key for remembering dismissal; defaults to the content. */
      id: z.string().optional(),
      link: z
        .object({ href: z.string(), text: z.string() })
        .strict()
        .optional(),
    })
    .strict(),
]);

const contentConfigSchema = z
  .object({
    defaultType: z.string().default("doc"),
    exclude: z.array(z.string()).default(["**/_*", "**/.*"]),
    include: z.array(z.string()).default(["**/*.{md,mdx}"]),
    pages: z.string().default("pages"),
    root: z.string().default("docs"),
  })
  .strict();

const navTabSchema = z
  .object({
    icon: iconName.optional(),
    label: z.string(),
    path: z.string(),
  })
  .strict();

/** A node in an explicit sidebar config: a page reference or a group/link. */
export type SidebarItemConfig =
  | string
  | {
      label: string;
      href?: string;
      icon?: string;
      collapsed?: boolean;
      items?: SidebarItemConfig[];
    };

const sidebarItemSchema: z.ZodType<SidebarItemConfig> = z.lazy(() =>
  z.union([
    z.string(),
    z
      .object({
        collapsed: z.boolean().optional(),
        href: z.string().optional(),
        icon: iconName.optional(),
        items: z.array(sidebarItemSchema).optional(),
        label: z.string(),
      })
      .strict(),
  ])
);

const navigationConfigSchema = z
  .object({
    /** Explicit sidebar override; when omitted the sidebar is generated. */
    sidebar: z.array(sidebarItemSchema).optional(),
    tabs: z.array(navTabSchema).optional(),
  })
  .strict();

/** A curated Google Font slug (see `theme/fonts.ts`). */
const fontSlug = z.string().refine(isFontSlug, (value) => ({
  message: `Unknown font "${value}". Supported fonts: ${FONT_SLUGS.join(", ")}.`,
}));

const themeConfigSchema = z
  .object({
    accent: z.string().default("blue"),
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

const aiConfigSchema = z
  .object({
    ask: z
      .object({
        enabled: z.boolean().default(false),
        model: z.string().default("openai/gpt-5.5"),
      })
      .strict()
      .optional(),
    llmsTxt: z.boolean().default(false),
  })
  .strict();

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
    enabled: z.boolean().default(false),
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

/**
 * "Last updated" timestamps for content pages. `false` (default) disables the
 * feature; `true` derives each page's date from git history; an object selects
 * the source explicitly. A page's `lastModified` frontmatter always wins.
 */
const lastModifiedConfigSchema = z.union([
  z.boolean(),
  z.object({ type: z.enum(["git", "frontmatter"]).default("git") }).strict(),
]);

const markdownConfigSchema = z
  .object({
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
    deployment: deploymentConfigSchema.default({}),
    description: z.string().optional(),
    github: githubConfigSchema.optional(),
    lastModified: lastModifiedConfigSchema.default(false),
    logo: logoConfigSchema.optional(),
    markdown: markdownConfigSchema.default({}),
    navigation: navigationConfigSchema.default({}),
    openapi: openapiConfigSchema.default({}),
    redirects: z.array(redirectSchema).default([]),
    search: searchConfigSchema.default({}),
    seo: seoConfigSchema.default({}),
    theme: themeConfigSchema.default({}),
    title: z.string().default("Documentation"),
  })
  .strict();

/** Resolved config: every field present after defaults are applied. */
export type ResolvedConfig = z.infer<typeof blumeConfigSchema>;
/** User-authored config: the shape accepted by `defineConfig`. */
export type BlumeConfig = z.input<typeof blumeConfigSchema>;
/** A configured search backend. */
export type SearchProvider = (typeof searchProviders)[number];
