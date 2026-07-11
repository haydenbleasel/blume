import type { ResolvedConfig, ResolvedI18nConfig } from "./schema.ts";
import type { Diagnostic, PageRecord } from "./types.ts";
import { UI_PACKS } from "./ui-packs/index.ts";

/**
 * Locale logic, centralized. Every seam that needs to reason about locales
 * (content discovery, navigation, manifest, runtime generation, the catch-all)
 * goes through these helpers so the routing rules live in exactly one place.
 */

/** Locale codes Blume recognizes (those it ships a UI pack for, plus English). */
const KNOWN_LOCALES = new Set(
  [...Object.keys(UI_PACKS), "en"].map((code) => code.toLowerCase())
);

/** True when the project opts into i18n. */
export const i18nEnabled = (
  config: ResolvedConfig
): config is ResolvedConfig & { i18n: ResolvedI18nConfig } =>
  config.i18n !== undefined;

/** All configured locale codes, default first as authored. */
export const localeCodes = (i18n: ResolvedI18nConfig): string[] =>
  i18n.locales.map((locale) => locale.code);

/** Text direction for a locale (`ltr` when unknown). */
export const localeDir = (
  code: string,
  i18n: ResolvedI18nConfig
): "ltr" | "rtl" =>
  i18n.locales.find((locale) => locale.code === code)?.dir ?? "ltr";

/**
 * The locale a missing translation falls back to: `fallbackLocale` when set,
 * the default locale when `fallbackLocale` is omitted, or `null` (disabled)
 * when explicitly set to `null`.
 */
export const resolveFallbackLocale = (
  i18n: ResolvedI18nConfig
): string | null => {
  if (i18n.fallbackLocale === null) {
    return null;
  }
  return i18n.fallbackLocale ?? i18n.defaultLocale;
};

/** URL prefix for a locale: `""` for the hidden default, else `/<code>`. */
export const localePrefix = (code: string, i18n: ResolvedI18nConfig): string =>
  code === i18n.defaultLocale && i18n.hideDefaultLocalePrefix ? "" : `/${code}`;

/**
 * Prefix a locale-agnostic route (e.g. `/guides/x` or `/`) with its locale.
 * `/` becomes `/fr` (or stays `/` for the hidden default).
 */
export const localizeRoute = (
  logicalRoute: string,
  code: string,
  i18n: ResolvedI18nConfig
): string => {
  const prefix = localePrefix(code, i18n);
  if (!prefix) {
    return logicalRoute;
  }
  return logicalRoute === "/" ? prefix : `${prefix}${logicalRoute}`;
};

/**
 * Detect a leading non-default locale directory in a path's segments. The
 * default locale lives at the content root, so only non-default codes are
 * matched as a leading segment. Returns the resolved locale and the remaining
 * (locale-stripped) segments.
 */
export const detectLocale = (
  parts: string[],
  i18n: ResolvedI18nConfig
): { locale: string; rest: string[] } => {
  // BCP 47 codes are case-insensitive: a conventional lowercase folder
  // (`pt-br/`) must match a configured `pt-BR`. The configured casing is what
  // flows into routes and labels.
  const first = parts[0]?.toLowerCase();
  const matched = i18n.locales.find(
    (locale) =>
      locale.code !== i18n.defaultLocale && locale.code.toLowerCase() === first
  );
  if (matched) {
    return { locale: matched.code, rest: parts.slice(1) };
  }
  return { locale: i18n.defaultLocale, rest: parts };
};

/**
 * Resolve where a content file lives across locales, by parser:
 * - `dir`: a leading locale directory (`fr/page.mdx`)
 * - `dot`: a filename suffix (`page.fr.mdx`)
 *
 * A `.$.` infix (e.g. `changelog.$.mdx`) marks a shared, locale-agnostic file
 * that is materialized into every configured locale. Returns the locale-stripped
 * path (used for nav grouping) and the locale codes the file maps to (one for a
 * normal file, all locales for a shared one).
 */
export const localePlacement = (
  rel: string,
  ext: string,
  i18n: ResolvedI18nConfig
): { navPath: string; locales: string[] } => {
  const base = rel.slice(0, rel.length - ext.length);

  // Shared `$` file: the same content in every locale.
  if (base.endsWith(".$")) {
    return {
      locales: i18n.locales.map((locale) => locale.code),
      navPath: `${base.slice(0, -2)}${ext}`,
    };
  }

  if (i18n.parser === "dot") {
    const lastDot = base.lastIndexOf(".");
    // Only a dot inside the filename (not a directory) is a locale suffix. Any
    // configured locale counts — including the default, so the symmetric
    // authoring `intro.en.mdx` + `intro.fr.mdx` shares one translation key
    // instead of routing the default file to a literal `/intro.en`.
    if (lastDot > base.lastIndexOf("/")) {
      // Case-insensitive, like `detectLocale`: `intro.pt-br.mdx` matches a
      // configured `pt-BR` and adopts its casing.
      const suffix = base.slice(lastDot + 1).toLowerCase();
      const matched = i18n.locales.find(
        (locale) => locale.code.toLowerCase() === suffix
      );
      if (matched) {
        return {
          locales: [matched.code],
          navPath: `${base.slice(0, lastDot)}${ext}`,
        };
      }
    }
    return { locales: [i18n.defaultLocale], navPath: rel };
  }

  const { locale, rest } = detectLocale(rel.split("/"), i18n);
  return { locales: [locale], navPath: rest.join("/") };
};

/**
 * Warn about top-level content folders that look like a locale (a code Blume
 * recognizes) but aren't declared in `i18n.locales`. Without this they're
 * silently treated as default-locale content under a `/<code>/…` route, which
 * is almost never intended — usually a translation that wasn't registered.
 */
export const i18nDiagnostics = (
  pages: PageRecord[],
  i18n: ResolvedI18nConfig
): Diagnostic[] => {
  const configured = new Set(
    i18n.locales.map((locale) => locale.code.toLowerCase())
  );
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const page of pages) {
    // The locale-looking folder is the first segment of the source-local ref
    // (e.g. `fr/guide.md`), not the namespaced id (`filesystem:fr/guide.md`).
    const first = page.source.ref.split("/")[0]?.toLowerCase();
    if (
      first &&
      !seen.has(first) &&
      KNOWN_LOCALES.has(first) &&
      !configured.has(first)
    ) {
      seen.add(first);
      diagnostics.push({
        code: "BLUME_I18N_UNCONFIGURED_LOCALE",
        message: `Folder "${first}/" looks like a locale, but "${first}" is not in i18n.locales — its pages are treated as "${i18n.defaultLocale}" content at /${first}/….`,
        severity: "warning",
        suggestion: `Add { code: "${first}", label: "…" } to i18n.locales, or rename the folder if it isn't a translation.`,
      });
    }
  }
  return diagnostics;
};
