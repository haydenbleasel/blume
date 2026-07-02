import type { UIStrings } from "./i18n-ui.ts";
import type { ResolvedConfig, SearchProvider } from "./schema.ts";
import type { Navigation, RouteAlternate } from "./types.ts";

/**
 * The shape of the `blume:data` virtual module — the resolved, serializable
 * snapshot of a site that custom `.astro` pages read with
 * `import data from "blume:data"`. `buildRuntimeData` (`astro/generate.ts`)
 * produces exactly this object and annotates it with {@link BlumeData}, so the
 * documented type and the emitted JSON stay in lockstep.
 */

/** Resolved site logo: an inlined SVG, or light/dark image URLs. */
export interface BlumeLogo {
  svg?: string;
  light?: string;
  dark?: string;
  alt: string;
  href: string;
}

/** A favicon or apple-touch-icon: a link href plus an optional MIME type. */
export interface BlumeFavicon {
  href: string;
  type?: string;
}

/** Announcement banner, normalized from its config (string shorthand or object). */
export interface BlumeBanner {
  content: string;
  link?: { href: string; text: string };
  dismissible: boolean;
  /** Dismissal key: the configured id, else the content itself. */
  key: string;
}

/** A generated syndication feed surfaced in the UI. */
export interface BlumeFeed {
  href: string;
  title: string;
}

/** One configured locale, as exposed to the runtime. */
export interface BlumeDataLocale {
  code: string;
  dir: "ltr" | "rtl";
  label: string;
}

/** Resolved i18n settings; `null` when the site is single-locale. */
export interface BlumeDataI18n {
  defaultLocale: string;
  /** Locale whose content renders for a missing translation; `null` disables it. */
  fallbackLocale: string | null;
  hideDefaultLocalePrefix: boolean;
  locales: BlumeDataLocale[];
}

/** A single content route, with the metadata custom pages can read. */
export interface BlumeRoute {
  /** Locales this logical page is translated into (excludes fallbacks). */
  alternates: RouteAlternate[];
  /** Astro collection the entry renders through (`"docs"` | `"staged"`). */
  collection: string;
  draft: boolean;
  /** "Edit this page" URL, or `null` when no repo/source provides one. */
  editUrl: string | null;
  /** Astro collection entry id (for `getEntry`/`getCollection`); matches `id`. */
  entryId: string;
  /** True when this route renders fallback content for a missing translation. */
  fallback: boolean;
  hidden: boolean;
  id: string;
  /** Whether the page is part of the search index. */
  indexable: boolean;
  /** ISO "last updated" date when the feature is on, else `null`. */
  lastModified: string | null;
  /** Resolved locale code (the default locale when not under i18n). */
  locale: string;
  path: string;
  title: string;
}

/** Site-wide settings derived from `blume.config` — the `config` field of {@link BlumeData}. */
export interface BlumeDataConfig {
  analytics: NonNullable<ResolvedConfig["analytics"]> | null;
  /** Apple touch icon, or `null` when none is configured/detected. */
  appleIcon: BlumeFavicon | null;
  banner: BlumeBanner | null;
  /** `markdown.code.wrap`: wrap long code lines instead of scrolling. */
  codeWrap: boolean;
  description: string | undefined;
  favicon: BlumeFavicon;
  feedback: boolean;
  i18n: BlumeDataI18n | null;
  /** `markdown.imageZoom`: click-to-zoom content images. */
  imageZoom: boolean;
  logo: BlumeLogo | null;
  /** Hosted MCP server, or `null` when MCP is off. */
  mcp: { name: string; route: string } | null;
  /** Open Graph image generation. */
  og: { enabled: boolean };
  /** Repository URL for header/edit links, or `null`. */
  repoUrl: string | null;
  search: { enabled: boolean; provider: SearchProvider };
  /** Deployment site URL, or `null` when none is configured/detected. */
  site: string | null;
  structuredData: boolean;
  theme: ResolvedConfig["theme"];
  title: string;
  /** Table-of-contents settings: whether to show it and the heading range. */
  toc: ResolvedConfig["toc"];
}

/**
 * The compact snapshot the layout serializes into the page for React island
 * hooks (`blume/hooks`). Islands hydrate independently, so this is read from a
 * `<script type="application/json" id="blume-client-data">` tag rather than
 * React context.
 */
export interface BlumeClientData {
  config: BlumeDataConfig;
  navigation: Navigation;
  page: { route: string; title: string };
}

/** The `blume:data` module a Blume site's custom pages import. */
export interface BlumeData {
  config: BlumeDataConfig;
  feeds: BlumeFeed[];
  /** CSS variable names for the configured fonts (Astro `<Font>` integration). */
  fontCssVars: string[];
  /** Sidebar + tab tree for the default locale. */
  navigation: Navigation;
  /** Per-locale navigation trees, keyed by locale code (empty without i18n). */
  navigationByLocale: Record<string, Navigation>;
  routes: BlumeRoute[];
  /** Resolved UI strings for the default locale. */
  ui: UIStrings;
  /** Per-locale UI strings, keyed by locale code (empty without i18n). */
  uiByLocale: Record<string, UIStrings>;
}
