import { z } from "zod";

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

const apiMetaSchema = z
  .object({
    auth: z.string().optional(),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      .optional(),
    path: z.string().optional(),
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
    api: apiMetaSchema.optional(),
    changelog: changelogMetaSchema.optional(),
    /** Publish date for feed-backed content like blog/changelog. */
    date: dateSchema.optional(),
    description: z.string().optional(),
    draft: z.boolean().default(false),
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

const themeConfigSchema = z
  .object({
    accent: z.string().default("blue"),
    layout: z.enum(["sidebar"]).default("sidebar"),
    mode: z.enum(["system", "light", "dark"]).default("system"),
    radius: z.enum(["none", "sm", "md", "lg"]).default("md"),
  })
  .strict();

const searchConfigSchema = z
  .object({
    indexing: z
      .object({
        includeHiddenPages: z.boolean().default(false),
      })
      .strict()
      .default({}),
    provider: z.enum(["orama", "pagefind", "none"]).default("orama"),
  })
  .strict();

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

/** Full user-facing config schema. All fields optional with defaults. */
export const blumeConfigSchema = z
  .object({
    ai: aiConfigSchema.default({}),
    analytics: analyticsConfigSchema.optional(),
    banner: bannerConfigSchema.optional(),
    content: contentConfigSchema.default({}),
    deployment: deploymentConfigSchema.default({}),
    description: z.string().optional(),
    github: githubConfigSchema.optional(),
    logo: logoConfigSchema.optional(),
    markdown: markdownConfigSchema.default({}),
    navigation: navigationConfigSchema.default({}),
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
