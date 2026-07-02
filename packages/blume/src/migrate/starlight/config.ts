import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { join } from "pathe";

import type { BlumeConfig, SidebarItemConfig } from "../../core/schema.ts";
import type { LiteralValue } from "../shared.ts";
import {
  asLiteralArray as asArray,
  asLiteralString as asString,
  isLiteralObject as isObject,
  parseLiteral,
  scanObject,
  stripJsComments,
} from "../shared.ts";

/**
 * Translate a Starlight `astro.config.*` into a `BlumeConfig`. The
 * `starlight({...})` options object is read statically out of the source text —
 * never executed — mirroring the Nextra `_meta` reader. Values that aren't pure
 * literals are skipped and reported, so a config that references imported assets
 * or plugins still yields a usable result instead of failing wholesale.
 */

const CONFIG_FILES = [
  "astro.config.mjs",
  "astro.config.mts",
  "astro.config.ts",
  "astro.config.js",
  "astro.config.cjs",
];

const STARLIGHT_IMPORT =
  /import\s+(?<name>\w+)\s+from\s+["']@astrojs\/starlight["']/u;

type StarlightOptions = Record<string, LiteralValue>;

/** Extract the object literal passed to `starlight(…)` from config source. */
const extractStarlightOptions = (
  source: string
): StarlightOptions | "unparseable" | "missing" => {
  const clean = stripJsComments(source);
  const importName = STARLIGHT_IMPORT.exec(clean)?.groups?.name ?? "starlight";
  const call = new RegExp(`\\b${importName}\\s*\\(`, "u").exec(clean);
  if (!call) {
    return "missing";
  }
  let index = call.index + call[0].length;
  while (index < clean.length && /\s/u.test(clean[index] ?? "")) {
    index += 1;
  }
  if (clean[index] !== "{") {
    // `starlight()` with no/non-literal options — nothing to translate.
    return clean[index] === ")" ? {} : "unparseable";
  }
  const scan = scanObject(clean, index);
  if (!scan) {
    return "unparseable";
  }
  const parsed = parseLiteral(clean.slice(index, scan.end + 1));
  return isObject(parsed) ? parsed : "unparseable";
};

export interface LoadedStarlightConfig {
  options: StarlightOptions;
  warnings: string[];
}

/** Locate and read the Starlight options out of the project's astro config. */
export const loadStarlightConfig = async (
  root: string
): Promise<LoadedStarlightConfig> => {
  const file = CONFIG_FILES.map((name) => join(root, name)).find((path) =>
    existsSync(path)
  );
  if (!file) {
    return {
      options: {},
      warnings: [
        "No astro.config.* found; wrote a default config — port your Starlight options by hand.",
      ],
    };
  }

  const source = await readFile(file, "utf-8");
  const result = extractStarlightOptions(source);
  if (result === "missing") {
    return {
      options: {},
      warnings: [
        "Could not find a starlight() call in astro.config.*; port your options by hand.",
      ],
    };
  }
  if (result === "unparseable") {
    return {
      options: {},
      warnings: [
        "Could not statically read the starlight() options; port your config by hand.",
      ],
    };
  }
  return { options: result, warnings: [] };
};

// ---------------------------------------------------------------------------
// Field mappers
// ---------------------------------------------------------------------------

type LogoConfig = string | { alt?: string; dark?: string; light?: string };

const mapLogo = (
  value: LiteralValue | undefined,
  warnings: string[]
): LogoConfig | undefined => {
  const logo = isObject(value) ? value : undefined;
  if (!logo) {
    return undefined;
  }
  const alt = asString(logo.alt);
  const src = asString(logo.src);
  const light = asString(logo.light);
  const dark = asString(logo.dark);

  let result: LogoConfig | undefined;
  if (src) {
    result = alt ? { alt, dark: src, light: src } : src;
  } else if (light || dark) {
    result = {
      ...(alt ? { alt } : {}),
      ...(dark ? { dark } : {}),
      ...(light ? { light } : {}),
    };
  }
  if (result) {
    warnings.push(
      "Mapped the Starlight logo; move the referenced file under public/ (Blume serves static assets from there)."
    );
  }
  return result;
};

const GITHUB_REPO = /github\.com\/(?<owner>[^/]+)\/(?<repo>[^/?#]+)/u;
const EDIT_LINK =
  /github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/edit\/(?<branch>[^/?#]+)/u;

interface GithubConfig {
  branch?: string;
  owner: string;
  repo: string;
}

const githubFromUrl = (url: string): GithubConfig | undefined => {
  const groups = GITHUB_REPO.exec(url)?.groups;
  if (!groups?.owner || !groups.repo) {
    return undefined;
  }
  return { owner: groups.owner, repo: groups.repo.replace(/\.git$/u, "") };
};

interface SocialMapping {
  github?: GithubConfig;
  socials: Record<string, string>;
}

/** Normalize a Starlight social icon key into a Blume `footer.socials` key. */
const socialKey = (icon: string): string =>
  icon.toLowerCase().replace(/\.com$/u, "");

const mapSocial = (value: LiteralValue | undefined): SocialMapping => {
  const result: SocialMapping = { socials: {} };
  const record = (icon: string, href: string): void => {
    const key = socialKey(icon);
    result.socials[key] = href;
    if (key === "github" && !result.github) {
      result.github = githubFromUrl(href);
    }
  };

  const array = asArray(value);
  if (array) {
    for (const entry of array) {
      if (!isObject(entry)) {
        continue;
      }
      const icon = asString(entry.icon);
      const href = asString(entry.href);
      if (icon && href) {
        record(icon, href);
      }
    }
    return result;
  }
  // Older Starlight: `social: { github: "https://…", discord: "https://…" }`.
  if (isObject(value)) {
    for (const [icon, href] of Object.entries(value)) {
      const url = asString(href);
      if (url) {
        record(icon, url);
      }
    }
  }
  return result;
};

const mapEditLink = (
  value: LiteralValue | undefined
): GithubConfig | undefined => {
  const editLink = isObject(value) ? value : undefined;
  const baseUrl = asString(editLink?.baseUrl);
  if (!baseUrl) {
    return undefined;
  }
  const groups = EDIT_LINK.exec(baseUrl)?.groups;
  if (!groups?.owner || !groups.repo || !groups.branch) {
    return undefined;
  }
  return {
    branch: groups.branch,
    owner: groups.owner,
    repo: groups.repo.replace(/\.git$/u, ""),
  };
};

/** Flatten a Starlight badge (`string` or `{ text, variant }`) to a string. */
const badgeText = (value: LiteralValue | undefined): string | undefined =>
  asString(value) ?? asString(isObject(value) ? value.text : undefined);

const mapSidebarItem = (
  value: LiteralValue,
  warnings: string[]
): SidebarItemConfig | null => {
  if (typeof value === "string") {
    return `/${value.replace(/^\/+/u, "")}`;
  }
  if (!isObject(value)) {
    return null;
  }
  const label = asString(value.label);
  const badge = badgeText(value.badge);
  const collapsed =
    typeof value.collapsed === "boolean" ? value.collapsed : undefined;

  const autogenerate = isObject(value.autogenerate)
    ? asString(value.autogenerate.directory)
    : undefined;
  if (autogenerate && label) {
    return {
      label,
      ...(badge ? { badge } : {}),
      ...(collapsed === undefined ? {} : { collapsed }),
      root: autogenerate,
    };
  }

  const items = asArray(value.items);
  if (items && label) {
    const mapped = items
      .map((item) => mapSidebarItem(item, warnings))
      .filter((item): item is SidebarItemConfig => item !== null);
    return {
      ...(badge ? { badge } : {}),
      ...(collapsed === undefined ? {} : { collapsed }),
      items: mapped,
      label,
    };
  }

  const link = asString(value.link);
  if (link) {
    return label
      ? { ...(badge ? { badge } : {}), href: link, label }
      : { href: link, label: link };
  }

  const slug = asString(value.slug);
  if (slug) {
    const href = `/${slug.replace(/^\/+/u, "")}`;
    return label ? { ...(badge ? { badge } : {}), href, label } : href;
  }

  warnings.push("Skipped a sidebar entry that uses an unsupported shape.");
  return null;
};

const mapSidebar = (
  value: LiteralValue | undefined,
  warnings: string[]
): SidebarItemConfig[] | undefined => {
  const array = asArray(value);
  if (!array) {
    return undefined;
  }
  const items = array
    .map((item) => mapSidebarItem(item, warnings))
    .filter((item): item is SidebarItemConfig => item !== null);
  return items.length > 0 ? items : undefined;
};

const mapCodeTheme = (
  value: LiteralValue | undefined,
  warnings: string[]
): { dark: string; light: string } | undefined => {
  const expressive = isObject(value) ? value : undefined;
  if (value === false) {
    warnings.push(
      "expressiveCode is disabled in Starlight; Blume always renders code blocks."
    );
    return undefined;
  }
  if (!expressive) {
    return undefined;
  }
  if (expressive.styleOverrides !== undefined) {
    warnings.push(
      "Dropped expressiveCode.styleOverrides; restyle code blocks via theme.css."
    );
  }
  const themes = asArray(expressive.themes)?.filter(
    (theme): theme is string => typeof theme === "string"
  );
  const [first, second] = themes ?? [];
  if (!first) {
    return undefined;
  }
  const dark = themes?.find((theme) => /dark/u.test(theme)) ?? first;
  const light =
    themes?.find((theme) => /light/u.test(theme)) ?? second ?? first;
  return { dark, light };
};

const mapHead = (
  value: LiteralValue | undefined,
  warnings: string[]
): Record<string, string> | undefined => {
  const array = asArray(value);
  if (!array) {
    return undefined;
  }
  const metatags: Record<string, string> = {};
  for (const entry of array) {
    if (!isObject(entry)) {
      continue;
    }
    const tag = asString(entry.tag);
    const attrs = isObject(entry.attrs) ? entry.attrs : undefined;
    const content = asString(attrs?.content);
    const key = asString(attrs?.name) ?? asString(attrs?.property);
    if (tag === "meta" && key && content) {
      metatags[key] = content;
    } else {
      warnings.push(
        `Dropped a <${tag ?? "?"}> head entry; re-add scripts/links via a custom layout.`
      );
    }
  }
  return Object.keys(metatags).length > 0 ? metatags : undefined;
};

/** Warn about Starlight options that carry over to Blume only by hand. */
const warnDroppedOptions = (
  options: StarlightOptions,
  warnings: string[]
): void => {
  if (options.customCss !== undefined) {
    warnings.push(
      "Dropped customCss; move your custom styles into a top-level theme.css."
    );
  }
  if (isObject(options.components)) {
    warnings.push(
      "Dropped Starlight component overrides; re-implement them via `blume eject`."
    );
  }
  if (asArray(options.plugins)?.length) {
    warnings.push(
      "Dropped Starlight plugins; they have no Blume equivalent and need manual review."
    );
  }
  if (options.routeMiddleware !== undefined) {
    warnings.push(
      "Dropped routeMiddleware; re-implement any route data in Blume directly."
    );
  }
};

/**
 * Map the statically-read Starlight options onto a `BlumeConfig`. Content stays
 * under `src/content/docs`, so the content root is pinned there. Unsupported or
 * non-literal options are dropped with a warning rather than failing.
 */
export const mapStarlightConfig = (
  options: StarlightOptions,
  warnings: string[]
): BlumeConfig => {
  const config: BlumeConfig = {
    content: { root: "src/content/docs" },
    title: asString(options.title) ?? "Documentation",
  };
  if (options.title !== undefined && asString(options.title) === undefined) {
    warnings.push(
      "Starlight title is per-locale or computed; set config.title manually."
    );
  }

  const description =
    asString(options.description) ?? asString(options.tagline);
  if (description) {
    config.description = description;
  }

  const logo = mapLogo(options.logo, warnings);
  if (logo) {
    config.logo = logo;
  }

  const favicon = asString(options.favicon);
  if (favicon) {
    config.favicon = favicon;
    if (!favicon.startsWith("/") && !/^https?:/u.test(favicon)) {
      warnings.push(
        `favicon "${favicon}" should live under public/ and be referenced from the site root.`
      );
    }
  }

  const social = mapSocial(options.social);
  const github = mapEditLink(options.editLink) ?? social.github;
  if (github) {
    config.github = github;
  }

  const sidebar = mapSidebar(options.sidebar, warnings);
  if (sidebar) {
    config.navigation = { sidebar };
  }

  const theme = mapCodeTheme(options.expressiveCode, warnings);
  if (theme) {
    config.markdown = { codeBlocks: { theme } };
  }

  const metatags = mapHead(options.head, warnings);
  if (metatags) {
    config.seo = { metatags };
  }

  if (options.lastUpdated === true) {
    config.lastModified = true;
  }

  warnDroppedOptions(options, warnings);

  return config;
};
