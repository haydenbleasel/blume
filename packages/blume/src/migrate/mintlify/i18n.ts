import type { BlumeConfig } from "../../core/schema.ts";

/** A Mintlify `navigation.languages[]` entry. */
interface MintlifyLanguage {
  language: string;
  default?: boolean;
}

/**
 * A display label for a locale code — the language's native name when the
 * runtime knows it (`fr` -> `Français`), else the code itself.
 */
const localeLabel = (code: string): string => {
  try {
    const native = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (native && native !== code) {
      return native.charAt(0).toUpperCase() + native.slice(1);
    }
  } catch {
    // Unknown code or no ICU data; fall through to the code.
  }
  return code;
};

/**
 * Map a Mintlify `navigation.languages[]` array to a Blume `i18n` config. The
 * entry marked `default: true` becomes `defaultLocale`; translated content
 * already lives in ISO-code directories, which match Blume's `dir` parser.
 */
export const mintlifyI18n = (
  spec: Record<string, unknown>
): BlumeConfig["i18n"] | null => {
  const navigation = spec.navigation as
    | { languages?: MintlifyLanguage[] }
    | undefined;
  const languages = navigation?.languages;
  if (!Array.isArray(languages) || languages.length < 2) {
    return null;
  }
  const defaultLocale =
    languages.find((entry) => entry.default)?.language ??
    languages[0]?.language ??
    "en";
  return {
    defaultLocale,
    locales: languages.map((entry) => ({
      code: entry.language,
      label: localeLabel(entry.language),
    })),
  };
};
