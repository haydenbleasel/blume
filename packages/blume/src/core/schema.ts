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

const changelogMetaSchema = z
  .object({
    category: z.string().optional(),
    date: dateSchema.optional(),
    version: z.string().optional(),
  })
  .strict();

const mintlifySearchMetaSchema = z
  .object({
    boost: z.number().optional(),
    exclude: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

const mintlifySidebarMetaSchema = z
  .object({
    badge: z.string().optional(),
    hidden: z.boolean().optional(),
    icon: iconName.optional(),
    label: z.string().optional(),
    order: z.number().optional(),
  })
  .passthrough();

const mintlifyPageMetaInputSchema = z
  .object({
    api: z.unknown().optional(),
    asyncapi: z.string().optional(),
    boost: z.number().optional(),
    hidden: z.boolean().optional(),
    icon: iconName.optional(),
    noindex: z.boolean().optional(),
    openapi: z.string().optional(),
    search: mintlifySearchMetaSchema.optional(),
    sidebar: mintlifySidebarMetaSchema.optional(),
    sidebarTitle: z.string().optional(),
    tag: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

type MintlifyPageMetaInput = z.infer<typeof mintlifyPageMetaInputSchema>;

const normalizedMintlifySearch = (meta: MintlifyPageMetaInput) => ({
  ...meta.search,
  ...(meta.boost !== undefined && meta.search?.boost === undefined
    ? { boost: meta.boost }
    : {}),
});

const normalizedMintlifySidebar = (meta: MintlifyPageMetaInput) => ({
  ...meta.sidebar,
  ...(meta.sidebarTitle !== undefined && meta.sidebar?.label === undefined
    ? { label: meta.sidebarTitle }
    : {}),
  ...(meta.icon !== undefined && meta.sidebar?.icon === undefined
    ? { icon: meta.icon }
    : {}),
  ...(meta.tag !== undefined && meta.sidebar?.badge === undefined
    ? { badge: meta.tag }
    : {}),
  ...(meta.hidden === true && meta.sidebar?.hidden === undefined
    ? { hidden: true }
    : {}),
});

const mintlifyPageType = (meta: MintlifyPageMetaInput): string | undefined =>
  meta.type ??
  (meta.openapi !== undefined ||
  meta.asyncapi !== undefined ||
  meta.api !== undefined
    ? "api"
    : undefined);

const mintlifyNoindex = (meta: MintlifyPageMetaInput): boolean | undefined =>
  meta.hidden === true && meta.noindex === undefined ? true : meta.noindex;

const normalizeMintlifyPageMeta = (value: unknown): unknown => {
  const result = mintlifyPageMetaInputSchema.safeParse(value);
  if (!result.success) {
    return value;
  }

  const meta = result.data;
  return {
    ...meta,
    noindex: mintlifyNoindex(meta),
    search: normalizedMintlifySearch(meta),
    sidebar: normalizedMintlifySidebar(meta),
    type: mintlifyPageType(meta),
  };
};

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
    toc: tocMetaSchema.default(true),
    type: z.string().default("doc"),
  })
  .passthrough();

export const pageMetaSchema = z.preprocess(
  normalizeMintlifyPageMeta,
  pageMetaBaseSchema
);

export type PageMeta = z.infer<typeof pageMetaBaseSchema>;
export type PageMetaInput = z.input<typeof pageMetaBaseSchema>;

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

const fontConfigSchema = z
  .object({
    family: z.string().optional(),
    format: z.enum(["woff", "woff2"]).optional(),
    source: z.string().optional(),
    weight: z.number().optional(),
  })
  .strict();

const themeFontsConfigSchema = z
  .object({
    body: fontConfigSchema.optional(),
    family: z.string().optional(),
    format: z.enum(["woff", "woff2"]).optional(),
    heading: fontConfigSchema.optional(),
    source: z.string().optional(),
    weight: z.number().optional(),
  })
  .strict();

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
    fonts: themeFontsConfigSchema.default({}),
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

const searchConfigSchema = z
  .object({
    indexing: z
      .object({
        includeHiddenPages: z.boolean().default(false),
      })
      .strict()
      .default({}),
    prompt: z.string().optional(),
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
    selectors: z.array(navSelectorSchema).default([]),
    /** Explicit sidebar override; when omitted the sidebar is generated. */
    sidebar: z.array(sidebarItemSchema).optional(),
    sidebarVariants: z.array(sidebarVariantSchema).default([]),
    tabs: z.array(navTabSchema).optional(),
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

const markdownConfigSchema = z
  .object({
    codeBlocks: codeBlocksConfigSchema.default({}),
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
    favicon: faviconConfigSchema.optional(),
    footer: footerConfigSchema.default({}),
    github: githubConfigSchema.optional(),
    icons: iconsConfigSchema.default({}),
    logo: logoConfigSchema.optional(),
    markdown: markdownConfigSchema.default({}),
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
/** User-authored config: the shape accepted by `defineConfig`. */
export type BlumeConfig = z.input<typeof blumeConfigSchema>;
