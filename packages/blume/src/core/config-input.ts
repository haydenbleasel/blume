import type { z } from "zod";

import type { ComponentMarkdown } from "../ai/component-markdown.ts";
import type { FontSlug } from "../theme/fonts.ts";
import type {
  blumeConfigSchema,
  OpenApiSource,
  SearchProvider,
  SidebarDisplay,
  SidebarItemConfig,
} from "./schema.ts";
import type { ContentSource } from "./sources/types.ts";

/**
 * The public, hand-documented authoring type for `blume.config.ts`.
 *
 * This interface mirrors the input side of {@link blumeConfigSchema} — the Zod
 * schema is still the single source of validation truth, but the schema's
 * inferred type carries no doc comments, so this parallel interface exists
 * purely to give editors rich per-field hover text and autocomplete. A
 * compile-time guard at the bottom of this file fails `tsc` if the two ever
 * drift, so keep them in sync.
 *
 * @see {@link defineConfig} — the helper you actually call.
 */

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * A literal union that still accepts any other string, so known values
 * autocomplete without rejecting custom ones (matches the schema's `string`).
 */
type LiteralUnion<T extends string> = T | (string & Record<never, never>);

/**
 * A per-color-mode value: a single string applies to both light and dark; the
 * object form sets each mode independently (either key may be omitted to
 * override just one mode).
 */
export type PerModeValue = string | { dark?: string; light?: string };

// ---------------------------------------------------------------------------
// Brand: logo & banner
// ---------------------------------------------------------------------------

/** The logo mark: a single image path/URL, or per-mode variants with alt text. */
export type LogoImage =
  | string
  | {
      /** Alt text for the mark. */
      alt?: string;
      /** Image shown in dark mode. */
      dark?: string;
      /** Image shown in light mode. */
      light?: string;
    };

/**
 * Site logo. A bare string is the image shorthand. The object form splits the
 * brand into an optional `image` mark and an optional wordmark `text`, so a site
 * can show an image-only logo, a text-only logo, or both.
 */
export type LogoConfig =
  | string
  | {
      /** Overrides the brand link target. Defaults to `/`. */
      href?: string;
      /** The logo mark. Omit for a text-only brand. */
      image?: LogoImage;
      /**
       * Wordmark text beside the mark. Omit to fall back to the site `title`;
       * set to `""` to render the mark alone.
       */
      text?: string;
    };

/**
 * Site-wide announcement banner shown above the header. A bare string is the
 * banner text; the object form adds an optional call-to-action link and
 * dismiss behavior.
 */
export type BannerConfig =
  | string
  | {
      /** The banner message. */
      content: string;
      /** Show a dismiss button; the choice is remembered per visitor. */
      dismissible?: boolean;
      /** Stable key for remembering dismissal; defaults to the content. */
      id?: string;
      /** An optional call-to-action link. */
      link?: {
        /** Link target (internal route or external URL). */
        href: string;
        /** Link text. */
        text: string;
      };
    };

// ---------------------------------------------------------------------------
// Content sources
// ---------------------------------------------------------------------------

/** Local Markdown/MDX read from the filesystem. */
export interface FilesystemSource {
  type: "filesystem";
  /** Glob patterns to ignore. Defaults to `["**\/_*", "**\/.*"]`. */
  exclude?: string[];
  /** Glob patterns to include. Defaults to `["**\/*.{md,mdx}"]`. */
  include?: string[];
  /** Namespaces this source's routes under `/<prefix>/`. */
  prefix?: string;
  /** Directory to read from, relative to the project root. Defaults to `docs`. */
  root?: string;
}

/**
 * Remote Markdown/MDX fetched over HTTP. Enumerate files explicitly against a
 * raw `url` base, or from a GitHub repo subtree via `github`. A private repo's
 * token comes from `GITHUB_TOKEN` — never inline it here.
 */
export interface MdxRemoteSource {
  type: "mdx-remote";
  /** Explicit list of source-relative file paths to fetch from `url`. */
  files?: string[];
  /** Enumerate a GitHub repo subtree via the git-trees API. */
  github?: {
    /** Repository owner (user or org). */
    owner: string;
    /** Subpath within the repo. Defaults to the repo root. */
    path?: string;
    /** Git ref (branch, tag, or SHA). Defaults to `main`. */
    ref?: string;
    /** Repository name. */
    repo: string;
  };
  /** Glob patterns applied to enumerated refs. Defaults to `["**\/*.{md,mdx}"]`. */
  include?: string[];
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Namespaces this source's routes under `/<prefix>/`. */
  prefix?: string;
  /** Raw base URL, e.g. `https://raw.githubusercontent.com/acme/sdk/main/docs`. */
  url?: string;
}

/**
 * A repo's GitHub Releases, materialized as `type: changelog` entries — release
 * notes become the changelog with no files to maintain. A private repo reads a
 * token from `GITHUB_TOKEN`; never inline it here.
 */
export interface GithubReleasesSource {
  type: "github-releases";
  /** Include draft releases (needs a token with repo write access). */
  drafts?: boolean;
  /** Cap the number of releases materialized, newest-first. Defaults to 100. */
  limit?: number;
  /** Repository owner (user or org). */
  owner: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Namespaces this source's routes under `/<prefix>/`; e.g. `changelog`. */
  prefix?: string;
  /** Include prereleases. */
  prereleases?: boolean;
  /** Repository name. */
  repo: string;
}

/** A Sanity dataset queried with GROQ; Portable Text bodies become Markdown. */
export interface SanitySource {
  type: "sanity";
  /** Sanity API version (a date). Defaults to `2024-01-01`. */
  apiVersion?: string;
  /** Dataset name to query. */
  dataset: string;
  /** Field paths mapping a document onto Blume meta + body. */
  fields?: {
    /** Field holding the renderable body (Portable Text or Markdown). */
    body?: string;
    /** Field holding the page description. */
    description?: string;
    /** Field holding the last-modified date. */
    lastModified?: string;
    /** Field holding the page slug. */
    slug?: string;
    /** Field holding the page title. */
    title?: string;
  };
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Namespaces this source's routes under `/<prefix>/`. */
  prefix?: string;
  /** Sanity project id. */
  projectId: string;
  /** GROQ query selecting the documents to import. */
  query: string;
}

/** A Notion database; pages become entries, blocks become MDX. */
export interface NotionSource {
  type: "notion";
  /** Notion database id. */
  database: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Namespaces this source's routes under `/<prefix>/`. */
  prefix?: string;
  /** Notion property names mapped onto Blume meta. */
  properties?: {
    /** Property holding the page description. */
    description?: string;
    /** Property holding the sort order. */
    order?: string;
    /** Property holding the page slug. */
    slug?: string;
    /** Property holding the publish status. */
    status?: string;
    /** Property holding the page title. */
    title?: string;
  };
  /** Status value treated as published; others map to `draft`. Defaults to `Published`. */
  publishedValue?: string;
}

/**
 * A user-provided {@link ContentSource} instance, passed straight through. This
 * is the extension point for adapters with custom serializers or any other
 * backend, without their SDKs touching core.
 */
export interface CustomSource {
  type: "custom";
  /** A `ContentSource` implementation (an object with `name` + `load`). */
  source: ContentSource;
}

/** A single configured content source, discriminated by `type`. */
export type ContentSourceInput =
  | FilesystemSource
  | MdxRemoteSource
  | GithubReleasesSource
  | SanitySource
  | NotionSource
  | CustomSource;

/**
 * Where content lives and how it's discovered. When `sources` is omitted, the
 * top-level `root`/`include`/`exclude` desugar to one implicit filesystem
 * source, so simple sites need nothing here.
 */
export interface ContentConfig {
  /** Default page `type` for content that sets none. Defaults to `doc`. */
  defaultType?: string;
  /** Glob patterns to ignore. Defaults to `["**\/_*", "**\/.*"]`. */
  exclude?: string[];
  /** Glob patterns to include. Defaults to `["**\/*.{md,mdx}"]`. */
  include?: string[];
  /** Directory of standalone `pages` (outside the docs tree). Defaults to `pages`. */
  pages?: string;
  /** Content root directory, relative to the project root. Defaults to `docs`. */
  root?: string;
  /**
   * Pluggable content sources. Mix local files with remote MDX, GitHub
   * Releases, Sanity, Notion, or a custom `ContentSource`.
   */
  sources?: ContentSourceInput[];
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** A single item inside a header tab's dropdown. */
export interface NavTabItem {
  /** Secondary line under the label. */
  description?: string;
  /** Lucide icon name shown beside the label. */
  icon?: string;
  /** Item label. */
  label: string;
  /** Route the item links to. */
  path: string;
  /** Short tag/pill (e.g. `New`, `Beta`). */
  tag?: string;
}

/** A top-level tab in the header, optionally opening a dropdown of items. */
export interface NavTab {
  /** Lucide icon name shown beside the label. */
  icon?: string;
  /** Dropdown items; omit for a plain link tab. */
  items?: NavTabItem[];
  /** Tab label. */
  label: string;
  /** Route the tab links to. */
  path: string;
}

/** A single option in a header selector (version, language, product, …). */
export interface NavSelectorItem {
  /** Secondary line under the label. */
  description?: string;
  /** Lucide icon name shown beside the label. */
  icon?: string;
  /** Option label. */
  label: string;
  /** Route the option links to. */
  path: string;
  /** Short tag/pill. */
  tag?: string;
}

/**
 * A header dropdown for switching context — versions, languages, products, or a
 * generic dropdown. `kind` drives the icon and a11y labeling.
 */
/** Context-partition selector kinds (a versioned/localized/multi-product site). */
type NavSelectorContextKind = "product" | "version";
/** What a header selector switches between. */
type NavSelectorKind = "dropdown" | "language" | NavSelectorContextKind;

export interface NavSelector {
  /** The options shown in the dropdown. */
  items?: NavSelectorItem[];
  /** What the selector switches between. */
  kind: NavSelectorKind;
  /** Selector label / current value. */
  label: string;
}

/**
 * A pinned link rendered above the sidebar sections — a blog, changelog, or
 * contact page that stays reachable regardless of the active tab. `href` may be
 * an internal route or an external URL.
 */
export interface FeaturedLink {
  /** Link target. */
  href: string;
  /** Lucide icon name shown beside the label. */
  icon?: string;
  /** Link label. */
  label: string;
}

/**
 * The sidebar. Omit `items` to generate the sidebar from the content tree;
 * provide `items` for a fully explicit sidebar. `display` sets how every group
 * renders by default (an individual group may override it). A bare array is
 * shorthand for `{ items }`.
 */
export type SidebarConfig =
  | SidebarItemConfig[]
  | {
      /**
       * Default group rendering: `flat` (header + list), `group` (collapsible
       * disclosure), or `page` (drill-in sub-panel). Defaults to `flat`.
       */
      display?: SidebarDisplay;
      /** Explicit sidebar nodes; omit to auto-generate from content. */
      items?: SidebarItemConfig[];
    };

/** Header, sidebar, tabs, and switcher configuration. */
export interface NavigationConfig {
  /** Pinned links shown above the generated sidebar sections. */
  featured?: FeaturedLink[];
  /** Show a GitHub repo link in the header (requires `github` configured). */
  repo?: boolean;
  /** Context switchers shown in the header (versions, languages, …). */
  selectors?: NavSelector[];
  /** Sidebar behavior and (optionally) an explicit sidebar tree. */
  sidebar?: SidebarConfig;
  /** Top-level tabs shown in the header. */
  tabs?: NavTab[];
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** The three type roles, each a curated Google Font slug. */
export interface FontsConfig {
  /** Body / prose font. Defaults to `inter`. */
  body?: LiteralUnion<FontSlug>;
  /** Display / heading font. Defaults to `inter-tight`. */
  display?: LiteralUnion<FontSlug>;
  /** Monospace / code font. Defaults to `ibm-plex-mono`. */
  mono?: LiteralUnion<FontSlug>;
}

/** Colors, fonts, radius, and color-mode behavior. */
/** Corner radius scale (`none`/`sm` tighter, `md`/`lg` rounder). */
type RadiusScaleTight = "none" | "sm";
type RadiusScaleRound = "md" | "lg";
type RadiusScale = RadiusScaleTight | RadiusScaleRound;

export interface ThemeConfig {
  /**
   * Accent color. A palette name (`blue`, `violet`, `green`, …) or any CSS
   * color applies to both modes; the object form sets each mode. Defaults to
   * `blue`.
   */
  accent?: string | { dark: string; light: string };
  /** Optional distinct color for call-to-action surfaces. */
  action?: string;
  /** Page background color, per mode. */
  background?: PerModeValue;
  /** Page background image (CSS `background-image` value), per mode. */
  backgroundImage?: PerModeValue;
  /** Font selection for body, display, and mono roles. */
  fonts?: FontsConfig;
  /** Overall page layout. Currently only `sidebar`. */
  layout?: "sidebar";
  /** Initial color mode. Defaults to `system`. */
  mode?: "system" | "light" | "dark";
  /** Corner radius scale. Defaults to `md`. */
  radius?: RadiusScale;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Public credentials for the Algolia backend (the sync key stays an env var). */
export interface AlgoliaSearch {
  appId: string;
  indexName: string;
  searchApiKey: string;
}

/** Public credentials for the Orama Cloud backend. */
export interface OramaCloudSearch {
  apiKey: string;
  endpoint: string;
  /** Index id used by the build-time sync (with `ORAMA_PRIVATE_API_KEY`). */
  indexId?: string;
}

/** Connection details for a self-hosted or cloud Typesense backend. */
export interface TypesenseSearch {
  collection: string;
  host: string;
  port?: number;
  protocol?: "http" | "https";
  searchApiKey: string;
}

/** Mixedbread semantic search: the store the server endpoint queries. */
export interface MixedbreadSearch {
  storeId: string;
}

/**
 * Search backend. The default `orama` builds a local index at build time (and
 * runs in dev); hosted providers need their credential block below. `none`
 * disables search.
 */
export interface SearchConfig {
  /** Algolia credentials (required when `provider` is `algolia`). */
  algolia?: AlgoliaSearch;
  /** Indexing behavior. */
  indexing?: {
    /** Include pages marked `hidden` in the search index. Defaults to `false`. */
    includeHiddenPages?: boolean;
  };
  /** Mixedbread store (required when `provider` is `mixedbread`). */
  mixedbread?: MixedbreadSearch;
  /** Orama Cloud credentials (required when `provider` is `orama-cloud`). */
  oramaCloud?: OramaCloudSearch;
  /** Which backend powers search. Defaults to `orama`. */
  provider?: SearchProvider;
  /** Typesense credentials (required when `provider` is `typesense`). */
  typesense?: TypesenseSearch;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/** An empty-state prompt shown before the first Ask AI question. */
export interface AskSuggestion {
  /** Lucide icon name shown beside the suggestion. */
  icon?: string;
  /** The clickable suggestion text. */
  label: string;
}

/** The Ask AI chat assistant. */
/** Backends that can route an Ask AI request. */
type AskProviderGateway = "gateway" | "openrouter" | "llmgateway";
type AskProvider = AskProviderGateway | "inkeep" | "openai-compatible";

export interface AskConfig {
  /**
   * Name of the env var holding the provider API key. Each provider has a
   * sensible default; set this only to override it.
   */
  apiKeyEnv?: string;
  /**
   * Backend base URL. Required for `openai-compatible`; for named providers it
   * overrides the built-in preset.
   */
  baseUrl?: string;
  /** Turn Ask AI on. Defaults to `false`. */
  enabled?: boolean;
  /** Model id to use. Defaults to `openai/gpt-5.5`. */
  model?: string;
  /** Which backend routes the request. Defaults to `gateway`. */
  provider?: AskProvider;
  /** Starter prompts shown before the first question. */
  suggestions?: AskSuggestion[];
}

/** What the `llms.txt`/`llms-full.txt` files include. */
export interface LlmsTxtConfig {
  /** Emit `llms.txt` and `llms-full.txt`. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Include the generated API reference pages (OpenAPI/AsyncAPI). Defaults to
   * `true`; set `false` to keep a placeholder or example spec's pages out of
   * the LLM-facing files.
   */
  openapi?: boolean;
}

/** Expose the docs as an MCP server for connecting agents. */
export interface McpConfig {
  /** Turn the MCP server on. Defaults to `false`. */
  enabled?: boolean;
  /** Optional system hint passed to connecting agents. */
  instructions?: string;
  /** Server name shown to clients; defaults to the site title. */
  name?: string;
  /** Route the server mounts at. Defaults to `/mcp`. */
  route?: string;
}

/**
 * AI-facing features: the Ask AI assistant, an `llms.txt` manifest, and the
 * hosted MCP server.
 */
export interface AiConfig {
  /** The Ask AI chat assistant. */
  ask?: AskConfig;
  /**
   * Emit `llms.txt` (an index of the docs for LLMs). Defaults to `true`.
   * The object form adds knobs for what the files include.
   */
  llmsTxt?: boolean | LlmsTxtConfig;
  /**
   * Markdown serializers for custom components in agent-facing output (the
   * `.md` mirror, `llms-full.txt`, MCP `get_page`), keyed by JSX name. Each
   * receives the component's statically-evaluated `props` and downleveled
   * `children` and returns replacement Markdown — or `null` to leave the JSX
   * verbatim. A same-name entry replaces a built-in serializer.
   *
   * These live in `blume.config.ts` (which is executed at build time), not in
   * `components.tsx` (which is only statically analyzed, never run).
   *
   * ```ts
   * ai: {
   *   markdownComponents: {
   *     Chart: ({ props }) => `![${props.title}](/charts/${props.slug}.png)`,
   *   },
   * }
   * ```
   */
  markdownComponents?: Record<string, ComponentMarkdown>;
  /** Expose the docs as an MCP server for agents. */
  mcp?: McpConfig;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** An arbitrary analytics `<script>`; set exactly one of `src` or `content`. */
export interface AnalyticsScript {
  /** Extra attributes spread onto the `<script>` (e.g. `data-domain`, `id`). */
  attributes?: Record<string, string>;
  /** Inline script body. Mutually exclusive with `src`. */
  content?: string;
  /** External script URL. Mutually exclusive with `content`. */
  src?: string;
  /** Load strategy for an external script. */
  strategy?: "async" | "defer";
}

/** Analytics providers. Configure one, several, or none. */
export interface AnalyticsConfig {
  /** PostHog product analytics. */
  posthog?: {
    /** API host (for self-hosted / EU). Defaults to PostHog cloud. */
    host?: string;
    /** Project API key. */
    key: string;
  };
  /** Escape hatch for any other provider (Plausible, Fathom, GA, Umami, …). */
  scripts?: AnalyticsScript[];
  /** Enable Vercel Web Analytics. */
  vercel?: boolean;
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

/** A configured locale plus display metadata for the switcher. */
export interface LocaleConfigInput {
  /** Locale code, e.g. `en`, `fr`, `pt-BR`. */
  code: string;
  /** Text direction; drives `<html dir>`. Defaults to `ltr`. */
  dir?: "ltr" | "rtl";
  /** Human-readable name shown in the switcher. */
  label: string;
}

/**
 * Internationalization. Opt-in: when omitted, Blume is single-locale. The
 * default locale lives at the content root; other locales are top-level
 * directories named by `code` (the `dir` parser) or filename suffixes (`dot`).
 */
export interface I18nConfig {
  /** Locale rendered at the content root. Defaults to `en`. */
  defaultLocale?: string;
  /** Locale rendered for a missing translation; `null` disables fallback. */
  fallbackLocale?: string | null;
  /** Drop the URL prefix for the default locale (`/`, `/fr/…`). Defaults to `true`. */
  hideDefaultLocalePrefix?: boolean;
  /** Every locale the site ships (at least one). */
  locales: LocaleConfigInput[];
  /** `dir`: locale directories (`fr/page.mdx`). `dot`: filename suffix (`page.fr.mdx`). */
  parser?: "dir" | "dot";
  /**
   * Per-locale UI string overrides, e.g.
   * `{ fr: { search: { button: "Rechercher" } } }`.
   */
  ui?: Record<string, Record<string, Record<string, string>>>;
}

// ---------------------------------------------------------------------------
// Deployment & redirects
// ---------------------------------------------------------------------------

/**
 * Where and how the site deploys. `site` (and `adapter`) are auto-detected from
 * the platform env on Vercel, Netlify, and Cloudflare.
 */
/** Astro server-output adapters, by hosting platform. */
type CloudDeploymentAdapter = "netlify" | "cloudflare";
type DeploymentAdapter = "vercel" | "node" | CloudDeploymentAdapter;

export interface DeploymentConfig {
  /** Astro adapter for server output. `null` (default) keeps a static build. */
  adapter?: DeploymentAdapter | null;
  /** Base path when the site is served from a subdirectory. */
  base?: string;
  /** Build output mode. Defaults to `static`. */
  output?: "static" | "server";
  /**
   * Canonical site URL. Needed for absolute links, the sitemap, and OG images;
   * auto-detected on supported platforms.
   */
  site?: string;
}

/** HTTP redirect status codes: permanent (301/308) and temporary (302/307). */
type RedirectStatusPermanent = 301 | 308;
type RedirectStatusTemporary = 302 | 307;
type RedirectStatus = RedirectStatusPermanent | RedirectStatusTemporary;

/** A URL redirect rule. */
export interface RedirectConfig {
  /** Path to redirect from. */
  from: string;
  /** HTTP status. Defaults to `301`. */
  status?: RedirectStatus;
  /** Path or URL to redirect to. */
  to: string;
}

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

/**
 * robots.txt `Content-Signal` preferences. `true` (default) declares the docs
 * open to search and agents; `false` opts out entirely; an object restricts
 * individual signals (unset signals stay allowed).
 */
export type ContentSignalsConfig =
  | boolean
  | {
      /** Allow grounding / RAG use at answer time (`ai-input`). Defaults to `true`. */
      aiInput?: boolean;
      /** Allow model training (`ai-train`). Defaults to `true`. */
      aiTrain?: boolean;
      /** Allow traditional and AI search indexing (`search`). Defaults to `true`. */
      search?: boolean;
    };

/** RSS/Atom feed generation. */
export interface RssConfig {
  /** Generate feeds. Defaults to `true`. */
  enabled?: boolean;
  /** Max items per feed, newest first. Defaults to `50`. */
  limit?: number;
  /** Content types that each get a feed at `/<type>/rss.xml`. Defaults to blog + changelog. */
  types?: string[];
}

/** Discoverability: OG images, feeds, sitemap, robots, and structured data. */
export interface SeoConfig {
  /**
   * Emit `agent-readability.json`: a manifest indexing the agent-facing surface
   * (llms.txt, Markdown mirrors, MCP, feeds). Defaults to `true`.
   */
  agentReadability?: boolean;
  /** robots.txt `Content-Signal` usage declaration. Defaults to `true`. */
  contentSignals?: ContentSignalsConfig;
  /** Per-page Open Graph image generation. */
  og?: {
    /**
     * Generate an OG image per page. Defaults to on once a deployment `site`
     * URL is known and off otherwise (`og:image` must be absolute). An explicit
     * value always wins.
     */
    enabled?: boolean;
  };
  /** Generate robots.txt (with a Sitemap reference when available). Defaults to `true`. */
  robots?: boolean;
  /** RSS/Atom feeds. */
  rss?: RssConfig;
  /** Generate sitemap.xml (requires `deployment.site`). Defaults to `true`. */
  sitemap?: boolean;
  /** Emit schema.org JSON-LD in each page's `<head>`. Defaults to `true`. */
  structuredData?: boolean;
  /**
   * X (Twitter) attribution for share cards. Handles may omit the `@`. The rest
   * of the X card is read from the `og:*` tags, so these accounts are the only
   * values X cannot infer.
   */
  x?: {
    /** Author account (`twitter:creator`); a page can override it via `seo.x.creator` frontmatter. */
    creator?: string;
    /** The site's own account (`twitter:site`), e.g. `@blume`. */
    handle?: string;
  };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/** Source repository, powering "Edit this page" links and the header repo link. */
export interface GithubConfig {
  /** Default branch. Defaults to `main`. */
  branch?: string;
  /** Path from the repo root to the project root (for monorepos). */
  dir?: string;
  /** Repository owner (user or org). */
  owner: string;
  /** Repository name. */
  repo: string;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Code-block rendering options. */
export interface CodeConfig {
  /** Show a brand language icon in the code-block header. Defaults to `true`. */
  icons?: boolean;
  /** Wrap long lines instead of scrolling horizontally. Defaults to `false`. */
  wrap?: boolean;
}

/** Markdown / MDX rendering behavior. */
export interface MarkdownConfig {
  /** Code-block rendering: language icons, line wrap. */
  code?: CodeConfig;
  /**
   * Syntax-highlighting themes for every code surface — fenced blocks, inline
   * `` `code`{:lang} ``, `<CodeBlock>`, and `<Diff>`.
   */
  codeBlocks?: {
    /** Shiki theme names per color mode. */
    theme?: {
      /** Dark-mode theme. Defaults to `github-dark`. */
      dark?: string;
      /** Light-mode theme. Defaults to `github-light`. */
      light?: string;
    };
  };
  /**
   * Wrap each `##`–`######` heading in a self-anchor link so readers can copy,
   * bookmark, or share a section permalink. Defaults to `true`.
   */
  headingAnchors?: boolean;
  /** Make content images click-to-zoom (lightbox). Defaults to `true`. */
  imageZoom?: boolean;
}

/** React island behavior. */
export interface ReactConfig {
  /**
   * Auto-memoize React components/hooks with the React Compiler
   * (`babel-plugin-react-compiler`). On by default whenever React is enabled;
   * set to `false` to skip the compiler's babel pass. Defaults to `true`.
   */
  compiler?: boolean;
}

// ---------------------------------------------------------------------------
// OpenAPI / AsyncAPI
// ---------------------------------------------------------------------------

/**
 * OpenAPI reference. By default (`renderer: "blume"`) Blume renders its own UI:
 * one real page per operation, grouped by tag in the sidebar and included in
 * search, llms.txt, and OG. Set `renderer: "scalar"` for the embedded Scalar
 * SPA (a single self-contained route).
 */
export interface OpenApiConfig {
  /** Code-sample languages shown per operation (Blume renderer). */
  codeSamples?: string[];
  /** Turn the reference on. Defaults to `false`. */
  enabled?: boolean;
  /** Start nested schema rows expanded (Blume renderer). Defaults to `false`. */
  expandSchemas?: boolean;
  /** Who renders the reference. Defaults to `blume`. */
  renderer?: "blume" | "scalar";
  /** Where the reference mounts. Defaults to `/reference`. */
  route?: string;
  /** One or more specs; each renders on its own route by default. */
  sources?: OpenApiSource[];
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec?: string;
  /** Scalar theme name (Scalar renderer only). */
  theme?: string;
}

/**
 * AsyncAPI reference, rendered via the embedded Scalar SPA (which auto-detects
 * the document type). Same shape as {@link OpenApiConfig}; only the default
 * `route` differs.
 */
export interface AsyncApiConfig {
  /** Turn the reference on. Defaults to `false`. */
  enabled?: boolean;
  /** Where the reference mounts. Defaults to `/events`. */
  route?: string;
  /** One or more specs. */
  sources?: OpenApiSource[];
  /** Shorthand for a single source. */
  spec?: string;
  /** Scalar theme name. */
  theme?: string;
}

// ---------------------------------------------------------------------------
// Misc top-level unions
// ---------------------------------------------------------------------------

/** `<Component />` example previews (the object form of `examples`). */
export interface ExamplesConfig {
  /**
   * A stylesheet, relative to the project root, injected into every preview
   * frame after Blume's default tokens. Previews render inside an isolated
   * iframe the docs styles never reach, so design tokens for the previewed
   * components — shadcn variables, `@theme` mappings, custom fonts — live
   * here. Tailwind is already provided in the frame; the file should hold
   * tokens and styles, not another `@import "tailwindcss"`.
   */
  css?: string;
  /**
   * Where example files live, relative to the project root. Defaults to
   * `examples`; may be a glob to target a registry that colocates component
   * sources with their examples (e.g. `registry/<pkg>/**\/examples/*`).
   */
  source?: string;
}

/**
 * Reader-facing "Export" page actions. A boolean toggles both formats; the
 * object form enables each individually. Defaults to `false`.
 */
export type ExportConfig =
  | boolean
  | {
      /** Offer EPUB export (client-side). Defaults to `false`. */
      epub?: boolean;
      /** Offer PDF export (via print). Defaults to `false`. */
      pdf?: boolean;
    };

/**
 * "Last updated" timestamps. `false` (default) disables them; `true` derives
 * each date from git history; the object form selects the source. A page's
 * `lastModified` frontmatter always wins.
 */
export type LastModifiedConfig =
  | boolean
  | {
      /** Where the date comes from. Defaults to `git`. */
      type?: "git" | "frontmatter";
    };

/**
 * On-page table of contents. `true`/`false` toggles it; the object form narrows
 * the heading range. Defaults to on, H2–H3.
 */
export type TocConfig =
  | boolean
  | {
      /** Deepest heading level to include (1–6). Defaults to `3`. */
      maxHeadingLevel?: number;
      /** Shallowest heading level to include (1–6). Defaults to `2`. */
      minHeadingLevel?: number;
    };

// ---------------------------------------------------------------------------
// The top-level config
// ---------------------------------------------------------------------------

/**
 * A Blume site's configuration — the object passed to {@link defineConfig} in
 * `blume.config.ts`. Every field is optional; an empty config renders the
 * Markdown/MDX under `docs/` with sensible defaults.
 */
export interface BlumeConfig {
  /** AI-facing features: the Ask AI assistant and an `llms.txt` manifest. */
  ai?: AiConfig;
  /** Analytics providers (PostHog, Vercel, or arbitrary scripts). */
  analytics?: AnalyticsConfig;
  /** AsyncAPI reference (embedded Scalar renderer). */
  asyncapi?: AsyncApiConfig;
  /** Site-wide announcement banner shown above the header. */
  banner?: BannerConfig;
  /**
   * Site-wide mount point prepended to every generated route (e.g. `/docs`) —
   * pages, links, redirects, sitemap, OG images, `llms.txt`, and the search
   * index — while staying invisible to the sidebar/nav tree (no wrapper group).
   * Distinct from a per-source `prefix` (which namespaces one source *and*
   * creates a group) and from `deployment.base` (Astro's host-subdirectory
   * base, for serving the whole site — root included — from a subpath). The two
   * compose: with both set, a page lands at `{deployment.base}/{basePath}/page`.
   */
  basePath?: string;
  /** Where content lives and how it's discovered. */
  content?: ContentConfig;
  /** Where and how the site deploys (site URL, adapter, output mode). */
  deployment?: DeploymentConfig;
  /** Default meta description, used where a page sets none. */
  description?: string;
  /**
   * `<Component path>` example previews. A string is shorthand for
   * `{ source }`: where examples live, relative to the project root (defaults
   * to `examples`; may be a glob to target a registry that colocates
   * component sources with their examples). The object form adds `css` — a
   * stylesheet injected into every preview frame (previews render in an
   * iframe the docs theme never reaches), for the previewed components'
   * design tokens, e.g. shadcn variables.
   */
  examples?: string | ExamplesConfig;
  /** Reader-facing PDF/EPUB export actions. Defaults to `false`. */
  export?: ExportConfig;
  /** Show the per-page "Was this helpful?" widget. Defaults to `true`. */
  feedback?: boolean;
  /** Source repository (Edit-this-page links and the header repo link). */
  github?: GithubConfig;
  /** Internationalization (opt-in multi-locale). */
  i18n?: I18nConfig;
  /** "Last updated" timestamps from git history or frontmatter. Defaults to `false`. */
  lastModified?: LastModifiedConfig;
  /** Site logo / brand mark. */
  logo?: LogoConfig;
  /** Markdown / MDX rendering behavior. */
  markdown?: MarkdownConfig;
  /** Header, sidebar, tabs, and switchers. */
  navigation?: NavigationConfig;
  /** Native OpenAPI reference. */
  openapi?: OpenApiConfig;
  /** React island behavior (compiler auto-memoization). */
  react?: ReactConfig;
  /** URL redirect rules. */
  redirects?: RedirectConfig[];
  /** Search backend and credentials. */
  search?: SearchConfig;
  /** Discoverability: OG images, feeds, sitemap, robots, structured data. */
  seo?: SeoConfig;
  /** Colors, fonts, radius, and color-mode behavior. */
  theme?: ThemeConfig;
  /** Site title, shown in the header, `<title>`, and OG images. Defaults to `Documentation`. */
  title?: string;
  /** On-page table of contents. Defaults to on (H2–H3). */
  toc?: TocConfig;
}

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

/**
 * Compile-time check that {@link BlumeConfig} stays structurally in sync with
 * the input side of {@link blumeConfigSchema}. If a schema field is added,
 * removed, renamed, retyped, or has its optionality changed, one of these
 * assertions stops compiling and this documented interface must be updated to
 * match. (Newly-added *nested optional* fields aren't caught by assignability
 * alone — the top-level key check below covers the common case; keep an eye on
 * nested additions.)
 */
type SchemaInput = z.input<typeof blumeConfigSchema>;

type AssertExtends<A extends B, B> = A;

// Every value accepted by `defineConfig` is a valid schema input.
type _ConfigIsValidInput = AssertExtends<BlumeConfig, SchemaInput>;
// Every value the schema accepts is expressible via the documented interface.
type _InputMatchesConfig = AssertExtends<SchemaInput, BlumeConfig>;
// Top-level key sets are identical (catches added/removed keys, even optional).
type _NoExtraOrMissingKeys = AssertExtends<
  | Exclude<keyof BlumeConfig, keyof SchemaInput>
  | Exclude<keyof SchemaInput, keyof BlumeConfig>,
  never
>;
