import type { AstroIntegration } from "astro";
import type { z } from "zod";

import type { AskRetrievalOptions } from "../ai/ask-context.ts";
import type { ComponentMarkdown } from "../ai/component-markdown.ts";
import type { CodeTheme } from "../markdown/themes.ts";
import type { FontSlug } from "../theme/fonts.ts";
import type {
  blumeConfigSchema,
  GraphqlSource,
  OpenApiSource,
  OpenInChatProvider,
  SearchProvider,
  SidebarDisplay,
  SidebarItemConfig,
} from "./schema.ts";
import type { ContentSource } from "./sources/types.ts";
import type { StandardSchema } from "./standard-schema.ts";

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
  /** Max concurrent Notion API requests; default 3 (Notion's per-integration pace). */
  concurrency?: number;
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
 * An Obsidian vault, read in place. Wikilinks become route links and
 * `%%comments%%` are stripped at load time, so the vault stays the source of
 * truth — no export step and no generated notes in the repo.
 */
export interface ObsidianSource {
  type: "obsidian";
  /** Vault folder names to skip at any depth, in addition to dot-folders. */
  exclude?: string[];
  /** Namespaces this source's routes under `/<prefix>/`; e.g. `vault`. */
  prefix?: string;
  /** Vault directory, absolute or relative to the project root. */
  vault: string;
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
  | ObsidianSource
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
  /**
   * Per-type content definitions, keyed by the frontmatter `type` they apply
   * to (including `defaultType`, for pages that set none):
   *
   * ```ts
   * import { z } from "zod";
   *
   * content: {
   *   types: {
   *     rfc: {
   *       frontmatter: {
   *         domain: z.string(),
   *         status: z.enum(["draft", "enforced"]),
   *       },
   *     },
   *   },
   * },
   * ```
   */
  types?: Record<string, ContentTypeConfig>;
}

/**
 * A per-type content definition: configuration that applies only to pages
 * whose resolved frontmatter `type` matches the map key.
 */
export interface ContentTypeConfig {
  /**
   * Custom frontmatter keys whose values become filterable facets for pages
   * of this type. Faceted values ride along on search documents
   * (`blume-search.json` and the MCP index), and the MCP `search_docs` and
   * `list_pages` tools accept a `filters` input matching against them:
   *
   * ```ts
   * content: {
   *   types: {
   *     rfc: {
   *       facets: ["domain", "status"],
   *       frontmatter: { domain: z.string(), status: z.string() },
   *     },
   *   },
   * },
   * ```
   *
   * Each name must be a custom key declared for the type — in its
   * `frontmatter` map or the site-wide `frontmatter.extend`. String values
   * facet as-is; numbers and booleans are stringified; anything else
   * (objects, arrays, transformed dates) does not facet.
   */
  facets?: string[];
  /**
   * Custom frontmatter keys for pages of this type, layered on top of the
   * site-wide `frontmatter.extend` (a key can be declared in one or the
   * other, not both). Schemas follow the same rules as `extend`: any
   * Standard Schema library works, every declared key is validated on every
   * page of the type — absent ones included — so a required schema enforces
   * the key type-wide (mark it `.optional()` to validate only when present),
   * and validated values land on the page record's `custom` field. Built-in
   * frontmatter fields cannot be redeclared.
   */
  frontmatter?: Record<string, StandardSchema>;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * A header label, optionally per locale: a plain string, or a map of locale
 * code to label (`{ en: "Docs", ja: "ドキュメント" }`). The active locale's
 * entry wins, then the default locale's, then the map's first entry.
 */
export type LocalizableLabel = string | Record<string, string>;

/** A single item inside a header tab's dropdown. */
export interface NavTabItem {
  /** Secondary line under the label. */
  description?: string;
  /** Lucide icon name shown beside the label. */
  icon?: string;
  /** Item label, optionally per locale. */
  label: LocalizableLabel;
  /** Route the item links to. */
  path: string;
  /** Short tag/pill (e.g. `New`, `Beta`). */
  tag?: string;
}

/** A top-level tab in the header, optionally opening a dropdown of items. */
export interface NavTab {
  /**
   * Where the tab links to, when that differs from `path`. `path` scopes the
   * sidebar section and matches the active tab; without `href`, a section whose
   * `path` isn't itself a page falls back to the section's first page, or keeps
   * `path` when the section has no linkable page at all. Set this to send
   * readers somewhere else — e.g. a generated `/changelog` index, or a custom
   * `.astro` landing page, neither of which is part of the content tree.
   */
  href?: string;
  /** Lucide icon name shown beside the label. */
  icon?: string;
  /** Dropdown items; omit for a plain link tab. */
  items?: NavTabItem[];
  /** Tab label, optionally per locale. */
  label: LocalizableLabel;
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

/** Fallback stack category for a custom font. */
export type FontFallback = "sans" | "serif" | "mono";

/**
 * Any family from a zero-config Astro font provider, by name. Self-hosted and
 * optimized like the curated slugs.
 */
export interface RemoteFontInput {
  /** Fallback stack. Defaults to `mono` for the mono role, `sans` otherwise. */
  fallback?: FontFallback;
  /** Family name as the provider lists it, e.g. `"Noto Sans JP"`. */
  name: string;
  /** Which provider serves the family. Defaults to `google`. */
  provider?: "google" | "fontsource" | "bunny" | "fontshare";
  /** Weights (or variable ranges like `"100..900"`) to load. Defaults to `[400, 500, 600, 700]`. */
  weights?: (number | string)[];
}

/** One local `@font-face`: a file plus optional weight/style (else inferred). */
export interface LocalFontVariantInput {
  /** Font file path, relative to the project root. */
  src: string;
  /** Face style; inferred from the file when omitted. */
  style?: "normal" | "italic" | "oblique";
  /** Face weight (a number or `"100..900"` range); inferred when omitted. */
  weight?: number | string;
}

/** A self-hosted family loaded from font files in the project. */
export interface LocalFontInput {
  /** Fallback stack. Defaults to `mono` for the mono role, `sans` otherwise. */
  fallback?: FontFallback;
  /** Family name used in CSS and the OG card. */
  name: string;
  /** The faces to declare (at least one). */
  variants: LocalFontVariantInput[];
}

/** A role's font: curated slug, remote-provider family, or local files. */
export type FontInput =
  | LiteralUnion<FontSlug>
  | RemoteFontInput
  | LocalFontInput;

/** The three type roles: a curated slug, any provider family, or local files. */
export interface FontsConfig {
  /** Body / prose font. Defaults to `inter`. */
  body?: FontInput;
  /** Display / heading font. Defaults to `inter` (shared with the body). */
  display?: FontInput;
  /** Monospace / code font. Defaults to `ibm-plex-mono`. */
  mono?: FontInput;
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

/** A curated link for the search dialog empty state. */
export interface SearchPopularLink {
  /** Internal route or external URL. */
  href: string;
  /**
   * Icon shown beside the label — a built-in name, image path/URL, or inline
   * SVG (same as nav icons). Defaults to the file glyph.
   */
  icon?: string;
  /** Link label shown in the dialog. */
  label: string;
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
  /**
   * Curated links for the Cmd+K empty state. When omitted or empty, the first
   * sidebar pages are shown instead.
   */
  popular?: SearchPopularLink[];
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

/** How much retrieved documentation each Ask AI question carries. */
export interface AskRetrievalConfig {
  /**
   * Total injected documentation characters, across all excerpts. Defaults to
   * `10000`. The single biggest lever on time-to-first-token — the model reads
   * every injected character before it emits a token.
   */
  contextBudget?: number;
  /**
   * Characters kept per excerpt. Defaults to `2000`. Raise it when one long
   * page holds the whole answer (a table the excerpt cuts in half); the
   * `contextBudget` still caps the total.
   */
  excerptChars?: number;
  /**
   * Documents retrieved per question. Defaults to `6`. The page the reader is
   * viewing is injected on top of the retrieved ones, so an answer can cite up
   * to one page more than this.
   */
  maxResults?: number;
}

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
  /**
   * Existing Ask AI endpoint to call instead of generating one. This keeps a
   * Blume site static while an API backend owns retrieval, model access, rate
   * limiting, and streaming. Accepts an absolute URL or root-relative path.
   */
  endpoint?: string;
  /**
   * Extra system-prompt text appended to the built-in instructions — use it
   * for identity, language, or tone. The built-in grounding behavior (answer
   * from the retrieved excerpts, cite pages as Markdown links) is preserved.
   */
  instructions?: string;
  /** Model id to use. Defaults to `openai/gpt-5.5`. */
  model?: string;
  /** Which backend routes the request. Defaults to `gateway`. */
  provider?: AskProvider;
  /**
   * How much documentation each question carries into the model's prompt.
   * Lower values cut time-to-first-token — which dominates on a self-hosted
   * backend — at the cost of recall. Defaults keep the built-in behavior.
   */
  retrieval?: AskRetrievalConfig;
  /** Starter prompts shown before the first question. */
  suggestions?: AskSuggestion[];
}

/** What the `llms.txt`/`llms-full.txt` files include. */
export interface LlmsTxtConfig {
  /**
   * Markdown placed after the title and summary in `llms.txt`, before the
   * page sections — the llms.txt spec's "details" block. Use it to tell
   * agents when to reach for the product and how to call it (a "When to use"
   * heading, the install command, the package name). Blank values are
   * dropped.
   *
   * ```ts
   * ai: {
   *   llmsTxt: {
   *     details: "## When to use Acme\n\nUse Acme when…",
   *   },
   * }
   * ```
   */
  details?: string;
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
   * receives the component's statically-evaluated `props` (with the page's
   * `frontmatter` in scope, so `prop={frontmatter.status}` resolves), its
   * downleveled `children`, and the page's `frontmatter` data, and returns
   * replacement Markdown — or `null` to leave the JSX verbatim. A same-name
   * entry replaces a built-in serializer.
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
  /**
   * The "Open in chat" page action, which opens the current page in an AI
   * assistant pre-filled with a prompt pointing at its raw Markdown.
   * Defaults to `true` (every provider). Set `false` to hide the action, or
   * list a subset of providers to show, in order.
   *
   * ```ts
   * ai: {
   *   openInChat: ["claude", "chatgpt", "cursor"],
   * }
   * ```
   */
  openInChat?: boolean | OpenInChatProvider[];
  /**
   * Publish Agent Skills for discovery: a directory (resolved against the
   * project root) whose subdirectories each hold a `SKILL.md`. Skills are
   * copied under `/.well-known/agent-skills/` — single-file skills verbatim,
   * skills with supporting resources as `.tar.gz` archives — and enumerated
   * in a discovery index with SHA-256 digests (Agent Skills Discovery RFC).
   *
   * ```ts
   * ai: {
   *   skills: "./skills",
   * }
   * ```
   */
  skills?: string;
  /**
   * Web Bot Auth: publish the org's HTTP Message Signature public keys at
   * `/.well-known/http-message-signatures-directory`, so sites receiving
   * requests from your agents can verify them. Public keys only — a key
   * containing private material (`d`, `p`, `q`, …) is rejected.
   */
  webBotAuth?: WebBotAuthConfig;
  /**
   * WebMCP: register in-page tools (search, page Markdown, the docs index)
   * on the browser's model context, so agentic browsers can drive the docs
   * without a separate MCP connection. The script is tiny and no-ops in
   * browsers without the API. Defaults to `true`; set `false` to opt out.
   */
  webmcp?: boolean;
}

/** Web Bot Auth signature directory. Off until at least one key is listed. */
export interface WebBotAuthConfig {
  /** Public JWKs to publish (e.g. an Ed25519 key: `kty: "OKP"`, `crv: "Ed25519"`, `x: …`). */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- mirrors the schema's `z.record(z.unknown())` (the drift guard requires it); JWK parameters are validated at parse time, not typed.
  keys?: Record<string, unknown>[];
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
  /**
   * Freeform style guidance for `blume translate`, e.g. "Brazilian
   * Portuguese, informal você". Pins register and dialect from the first
   * translation and wins over an existing translation's style on reruns.
   */
  style?: string;
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
// Versions
// ---------------------------------------------------------------------------

/** A frozen documentation snapshot: a directory under the content root. */
export interface ArchivedVersionInput {
  /**
   * The "you're viewing an old version" notice: `true` (default) for the
   * built-in message, a string for custom copy, `false` to hide it.
   */
  banner?: boolean | string;
  /**
   * Where this version's pages point their canonical URL. `latest` (default)
   * targets the same page in the current docs when it still exists (self
   * otherwise); `self` keeps every page authoritative.
   */
  canonical?: "latest" | "self";
  /**
   * Directory name under the content root, and the URL segment. Must start
   * with a letter (e.g. `v1.0`).
   */
  id: string;
  /** Switcher label; defaults to the id. */
  label?: string;
  /** Emit `noindex` on every page of this version. Defaults to `false`. */
  noindex?: boolean;
}

/**
 * Docs versioning. Opt-in: the latest docs live at the content root with
 * unprefixed URLs, and each archived version is a frozen snapshot directory
 * (`content/docs/<id>/`) cut with `blume version <id>`. Archived means frozen:
 * snapshots carry their own translations and are never retranslated.
 */
export interface VersionsConfig {
  /** Frozen snapshots, newest first — this order is the switcher order. */
  archived?: ArchivedVersionInput[];
  /** Labels the unprefixed tree (the latest docs) in the switcher. */
  current: {
    /** Small tag rendered next to the label (e.g. `Latest`). */
    badge?: string;
    label: string;
  };
  switcher?: {
    /**
     * Where switching lands when the page has no equivalent in the target
     * version: `same-page` (default) goes to the equivalent when it exists
     * (version root otherwise); `root` always goes to the version root.
     */
    redirect?: "same-page" | "root";
  };
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

/**
 * One authorized remote image source, passed through to Astro's
 * `image.remotePatterns`. Hostnames accept `*.` (one level) and `**.` (any
 * depth) wildcards; pathnames accept `/dir/*` and `/dir/**` the same way.
 */
export interface ImageRemotePattern {
  /** Hostname pattern, e.g. `"**.example.com"`. */
  hostname?: string;
  /** Pathname pattern, e.g. `"/images/**"`. */
  pathname?: string;
  /** Port, e.g. `"8080"`. */
  port?: string;
  /** URL scheme, e.g. `"https"`. */
  protocol?: string;
}

/**
 * Image optimization. Local images referenced by relative path are optimized
 * automatically; remote images are only optimized when their host is
 * authorized here. Both fields map directly onto Astro's `image` config.
 */
export interface ImageConfig {
  /** Hosts whose remote images may be optimized, e.g. `["cdn.example.com"]`. */
  domains?: string[];
  /** Pattern-based host authorization, for wildcards `domains` can't express. */
  remotePatterns?: ImageRemotePattern[];
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

/** Colors used by generated Open Graph cards. Any CSS color — hex, `oklch(…)`, `rgb(…)`, named. */
export interface OgPaletteConfig {
  /** Fallback mark color. Defaults to the light theme accent. */
  accent?: string;
  /** Card background. */
  background?: string;
  /** Footer divider. */
  border?: string;
  /** Headline and `currentColor` logo color. */
  foreground?: string;
  /** Description and footer text. */
  muted?: string;
}

/** Per-page Open Graph image generation. */
export interface OgConfig {
  /**
   * Card subtitle. Defaults to the site description; a string overrides it,
   * `false` renders the card without one.
   */
  description?: string | false;
  /**
   * Generate an OG image per page. Defaults to on once a deployment `site`
   * URL is known and off otherwise (`og:image` must be absolute). An explicit
   * value always wins.
   */
  enabled?: boolean;
  /**
   * Fonts for the generated card, extending Takumi's Latin-only default so
   * non-Latin titles (CJK, and so on) render instead of tofu. A bare string is
   * a Google Fonts family fetched at build; the name-only object form pins
   * weights (`700`, `[400, 700]`, or a `"100..900"` variable range) and
   * styles; the `src` form reads a local font file from the project instead.
   * When omitted and `theme.fonts` is explicitly configured, the theme's
   * display and body fonts are used automatically — pass `[]` to opt out.
   */
  fonts?: (
    | string
    | {
        name: string;
        style?: "normal" | "italic" | ("normal" | "italic")[];
        weight?: number | number[] | string;
      }
    | {
        /** Family name registered for the file's faces. */
        name: string;
        /** Font file path, relative to the project root. */
        src: string;
        style?: "normal" | "italic";
        weight?: number;
      }
  )[];
  /**
   * Local SVG used in the generated card instead of the site logo; `false`
   * renders the card without any brand mark.
   */
  logo?: string | false;
  /** Optional generated-card colors. */
  palette?: OgPaletteConfig;
  /**
   * Footer site text. Defaults to the deployment site's host plus
   * `deployment.base` (`docs.acme.com`, `user.github.io/repo`); a string
   * overrides it, `false` hides it.
   */
  site?: string | false;
  /**
   * Card headlines for custom `.astro` pages, keyed by route (`"/"`, `"/cli"`).
   * A custom page has no frontmatter to read, so its card is otherwise titled
   * by humanizing its last URL segment (`/cli` → "Cli"); an entry here wins.
   * Content pages always take their card headline from the page title.
   */
  titles?: Record<string, string>;
}

/** A schema.org `PostalAddress`; give whichever parts apply. */
export interface PostalAddressConfig {
  /** Country name or ISO 3166-1 alpha-2 code (`"US"`). */
  addressCountry?: string;
  /** City or locality. */
  addressLocality?: string;
  /** State, province, or region. */
  addressRegion?: string;
  postalCode?: string;
  streetAddress?: string;
}

/**
 * The organization behind the site, emitted in every page's JSON-LD as an
 * `Organization` node that the WebSite and article nodes cite as publisher.
 * Contact details become a `ContactPoint` and the address a `PostalAddress` —
 * the fields AI agents check to verify a business before recommending it.
 * Requires `deployment.site` (the node needs an absolute identifier).
 */
export interface OrganizationConfig {
  /** Postal address, emitted as a `PostalAddress` when any part is given. */
  address?: PostalAddressConfig;
  /** `ContactPoint.contactType` for the email/telephone. Defaults to `"customer support"`. */
  contactType?: string;
  /** Public contact email. */
  email?: string;
  /** Logo: an absolute URL or a root-relative path (`"/logo.svg"`). */
  logo?: string;
  /** Organization name. Defaults to the site title. */
  name?: string;
  /** Profile URLs that identify the organization (GitHub, X, LinkedIn, …). */
  sameAs?: string[];
  /** Public contact telephone number. */
  telephone?: string;
  /** Organization website. Defaults to the site origin. */
  url?: string;
}

/**
 * The product the site documents, emitted on the homepage as a
 * `SoftwareApplication` JSON-LD node — the identity type that tells agents
 * what the site is about. Requires `deployment.site`.
 */
export interface SoftwareConfig {
  /** schema.org application category. Defaults to `"DeveloperApplication"`. */
  applicationCategory?: string;
  /** Product description. Defaults to the site description. */
  description?: string;
  /** License URL or SPDX identifier (`"MIT"`). */
  license?: string;
  /** Product name. Defaults to the site title. */
  name?: string;
  /** Supported platform(s), e.g. `"Node.js 22+"`. */
  operatingSystem?: string;
  /** Price, emitted as an `Offer`; `0` marks the software free. */
  price?: number | string;
  /** Currency of `price` (ISO 4217). Defaults to `"USD"`. */
  priceCurrency?: string;
  /** Package registry, repository, and profile URLs for the product. */
  sameAs?: string[];
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
  og?: OgConfig;
  /**
   * The organization behind the site, added to every page's JSON-LD as an
   * `Organization` node with contact point and address.
   *
   * ```ts
   * seo: {
   *   organization: {
   *     email: "hello@acme.com",
   *     logo: "/logo.svg",
   *     sameAs: ["https://github.com/acme", "https://x.com/acme"],
   *   },
   * }
   * ```
   */
  organization?: OrganizationConfig;
  /** Generate robots.txt (with a Sitemap reference when available). Defaults to `true`. */
  robots?: boolean;
  /** RSS/Atom feeds. */
  rss?: RssConfig;
  /** Generate sitemap.xml (requires `deployment.site`). Defaults to `true`. */
  sitemap?: boolean;
  /**
   * The documented product, added to the homepage's JSON-LD as a
   * `SoftwareApplication` node. `true` takes every default (name and
   * description from the site); the object form fills in the rest.
   *
   * ```ts
   * seo: {
   *   software: { license: "MIT", operatingSystem: "Node.js 22+", price: 0 },
   * }
   * ```
   */
  software?: boolean | SoftwareConfig;
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
    /** Bundled Shiki theme names or inline custom Shiki themes per color mode. */
    theme?: {
      /** Dark-mode theme name or custom theme. Defaults to `github-dark`. */
      dark?: CodeTheme;
      /** Light-mode theme name or custom theme. Defaults to `github-light`. */
      light?: CodeTheme;
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
 * The shared shape of both API-reference blocks (`openapi`, `asyncapi`). Only
 * the per-block defaults differ; those are documented on the extending
 * interfaces.
 */
interface ReferenceConfig {
  /** Turn the reference on. Defaults to `false`. */
  enabled?: boolean;
  /** Start nested schema rows expanded (Blume renderer). Defaults to `false`. */
  expandSchemas?: boolean;
  /**
   * The interactive "Try it" panel on operation pages (Blume renderer). On by
   * default; `false` hides it. `proxy` is the CORS escape hatch the OpenAPI
   * Send button routes requests through: a proxy URL, or `true` for the
   * built-in `/_api-proxy` endpoint (which requires
   * `deployment.output: "server"`). `proxy` is OpenAPI-only — an event
   * composer's WebSocket connect is direct.
   */
  playground?: boolean | { enabled?: boolean; proxy?: boolean | string };
  /** Who renders the reference. Defaults to `blume`. */
  renderer?: "blume" | "scalar";
  /**
   * Extra Scalar options forwarded verbatim to the embedded `<ScalarComponent>`
   * (Scalar renderer only) — e.g. `localization`, `agent`,
   * `hideTestRequestButton`, `orderSchemaPropertiesBy`. These win over Blume's
   * derived spec/theme config, so it's a full escape hatch to Scalar's API.
   */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- mirrors the schema's `z.record(z.unknown())` (the drift guard requires it); the values are Scalar's own API surface, deliberately unmodeled.
  scalar?: Record<string, unknown>;
  /** One or more specs; each renders on its own route by default. */
  sources?: OpenApiSource[];
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec?: string;
  /** Scalar theme name (Scalar renderer only). */
  theme?: string;
}

/**
 * OpenAPI reference. By default (`renderer: "blume"`) Blume renders its own UI:
 * one real page per operation, grouped by tag in the sidebar and included in
 * search, llms.txt, and OG. Set `renderer: "scalar"` for the embedded Scalar
 * SPA (a single self-contained route).
 */
export interface OpenApiConfig extends ReferenceConfig {
  /**
   * Code-sample languages shown per operation (Blume renderer). Defaults to
   * `["curl", "js", "python"]`.
   */
  codeSamples?: string[];
  /** Where the reference mounts. Defaults to `/reference`. */
  route?: string;
}

/**
 * AsyncAPI reference. Same shape as {@link OpenApiConfig}: by default
 * (`renderer: "blume"`) Blume normalizes the spec to AsyncAPI 3.x and renders
 * its own UI — one real page per operation, grouped by tag (or channel) in the
 * sidebar and included in search, llms.txt, and OG. Set `renderer: "scalar"`
 * for the embedded Scalar SPA (a single self-contained route).
 */
export interface AsyncApiConfig extends ReferenceConfig {
  /**
   * Code-sample tools shown per operation (Blume renderer). Defaults to every
   * tool appropriate to the operation's protocol binding.
   */
  codeSamples?: string[];
  /** Where the reference mounts. Defaults to `/events`. */
  route?: string;
}

/**
 * GraphQL reference. Blume lowers the schema — SDL text or an introspection
 * JSON result, local or remote — into one real page per root field (grouped
 * as Queries/Mutations/Subscriptions) plus one page per named type (Objects,
 * Input Objects, Enums, Interfaces, Unions, Scalars), all in the sidebar,
 * search, llms.txt, and OG. Always Blume-rendered — the embedded Scalar SPA
 * reads OpenAPI documents only — so unlike the other reference blocks there
 * is no `renderer` opt-out.
 */
export interface GraphqlConfig {
  /**
   * Code-sample languages shown per operation. Defaults to
   * `["curl", "js", "python"]`.
   */
  codeSamples?: string[];
  /** Turn the reference on. Defaults to `false`. */
  enabled?: boolean;
  /**
   * URL of the live GraphQL endpoint the playground and code samples target —
   * a schema, unlike an OpenAPI document, names no server. Applies to every
   * source in the block; a per-source `endpoint` wins.
   */
  endpoint?: string;
  /**
   * The interactive "Try it" panel on operation pages. On by default; `false`
   * hides it. The object form keeps it on and sets `proxy`, the CORS escape
   * hatch the Send button routes requests through: a proxy URL, or `true` for
   * the built-in `/_api-proxy` endpoint (which requires
   * `deployment.output: "server"`).
   */
  playground?: boolean | { enabled?: boolean; proxy?: boolean | string };
  /** Where the reference mounts. Defaults to `/graphql`. */
  route?: string;
  /** One or more schemas; each renders on its own route by default. */
  sources?: GraphqlSource[];
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec?: string;
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
 * Opt-in custom frontmatter keys. Page frontmatter is strictly validated —
 * an unknown key fails the build so typos are caught — and `extend` carves
 * out project-specific keys from that rule, each validated by a schema you
 * supply.
 */
export interface FrontmatterConfig {
  /**
   * Extra frontmatter keys pages may carry, mapped to their validation
   * schemas — any library implementing Standard Schema works (Zod — the
   * version your project installs, 3.24+ or 4 — Valibot, ArkType):
   *
   * ```ts
   * import { z } from "zod";
   *
   * frontmatter: {
   *   extend: {
   *     owner: z.string(),
   *     reviewedAt: z.coerce.date().optional(),
   *   },
   * },
   * ```
   *
   * Every declared key is validated on every page — absent ones included —
   * so a required schema enforces the key site-wide; mark it `.optional()`
   * to validate only when present. Validated values are preserved on each
   * page record's `custom` field. Built-in frontmatter fields cannot be
   * redeclared. To scope a key to one content type instead, declare it under
   * `content.types.<type>.frontmatter`.
   */
  extend?: Record<string, StandardSchema>;
}

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
 * Date presentation for the "last updated" stamp and the changelog timeline —
 * a curated pass-through to `Intl.DateTimeFormat`, shared by both surfaces.
 * Defaults to `{ dateStyle: "long" }`. Dates render in UTC unless `timeZone` is
 * set. `dateStyle` is a preset and can't be combined with the component fields.
 */
export interface DateFormatConfig {
  /** Preset date length; mutually exclusive with the component fields below. */
  dateStyle?: "full" | "long" | "medium" | "short";
  /** Weekday representation. */
  weekday?: "long" | "short" | "narrow";
  /** Era representation (e.g. the Japanese imperial era). */
  era?: "long" | "short" | "narrow";
  /** Year representation. */
  year?: "numeric" | "2-digit";
  /** Month representation. */
  month?: "numeric" | "2-digit" | "long" | "short" | "narrow";
  /** Day representation. */
  day?: "numeric" | "2-digit";
  /** IANA time zone (e.g. `Asia/Tokyo`). Defaults to `UTC`. */
  timeZone?: string;
  /** Calendar system (e.g. `japanese`, `buddhist`). */
  calendar?: string;
  /** Numbering system (e.g. `latn`, `arab`). */
  numberingSystem?: string;
}

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
  /** AsyncAPI reference (native renderer by default, Scalar opt-out). */
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
  /**
   * Date presentation for the "last updated" stamp and the changelog timeline.
   * Pass-through `Intl.DateTimeFormat` options; defaults to `{ dateStyle: "long" }`.
   */
  dateFormat?: DateFormatConfig;
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
  /** Opt-in custom frontmatter keys, validated by schemas you supply. */
  frontmatter?: FrontmatterConfig;
  /** Source repository (Edit-this-page links and the header repo link). */
  github?: GithubConfig;
  /** Native GraphQL reference (root fields and named types as real pages). */
  graphql?: GraphqlConfig;
  /** Internationalization (opt-in multi-locale). */
  i18n?: I18nConfig;
  /** Image optimization: remote-host authorization for the image service. */
  image?: ImageConfig;
  /** Astro integrations appended after Blume's built-ins, in declaration order. */
  integrations?: AstroIntegration[];
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
  /** Docs versioning (opt-in frozen snapshots with a version switcher). */
  versions?: VersionsConfig;
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
// The retrieval shape lives in three places: this documented config interface,
// the schema, and the runtime `AskRetrievalOptions` that `createAskContext`
// reads (all-optional, so plain assignability is a weak-type check that a
// renamed field slips through — the value would be baked into the generated
// endpoint and silently ignored at request time). `Required` makes a rename in
// either copy a missing property, which stops compiling.
type _AskRetrievalMatchesRuntime = AssertExtends<
  Required<AskRetrievalConfig>,
  Required<AskRetrievalOptions>
>;
type _AskRuntimeMatchesRetrieval = AssertExtends<
  Required<AskRetrievalOptions>,
  Required<AskRetrievalConfig>
>;
