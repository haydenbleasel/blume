import { z } from "zod";

import { UI_PACKS } from "./ui-packs/index.ts";

/**
 * Translatable UI chrome strings.
 *
 * The schema is the single source of truth: each field's `.default()` is the
 * English baseline, so `EN_UI = uiStringsSchema.parse({})`. Shipped packs and
 * user overrides merge on top (see {@link resolveUIStrings}). Grouped by surface
 * to keep the runtime payload and component props readable.
 */
const uiStringsObject = z.object({
  actions: z
    .object({
      addToCursor: z.string().default("Add to Cursor"),
      addToVscode: z.string().default("Add to VS Code"),
      askAI: z.string().default("Ask AI about this page"),
      connectMcp: z.string().default("Connect to MCP"),
      copied: z.string().default("Copied!"),
      copyClaudeCode: z.string().default("Copy Claude Code command"),
      copyMarkdown: z.string().default("Copy as Markdown"),
      copyServerUrl: z.string().default("Copy server URL"),
      edit: z.string().default("Edit on GitHub"),
      feedbackPlaceholder: z.string().default("Leave your feedback…"),
      giveFeedback: z.string().default("Give feedback"),
      markdownSupported: z.string().default("Markdown supported"),
      openInChat: z.string().default("Open in chat"),
      scrollToTop: z.string().default("Scroll to top"),
      send: z.string().default("Send"),
    })
    .default({}),
  ask: z
    .object({
      empty: z.string().default("Ask a question about the docs."),
      error: z.string().default("Sorry, something went wrong."),
      label: z.string().default("Ask a question"),
      placeholder: z.string().default("Ask a question…"),
      send: z.string().default("Send"),
      title: z.string().default("Ask AI"),
    })
    .default({}),
  languageSwitcher: z
    .object({
      label: z.string().default("Language"),
      untranslated: z.string().default("Not translated"),
    })
    .default({}),
  page: z
    .object({
      lastUpdated: z.string().default("Last updated on"),
      next: z.string().default("Next"),
      previous: z.string().default("Previous"),
      skipToContent: z.string().default("Skip to content"),
    })
    .default({}),
  search: z
    .object({
      allLanguages: z.string().default("All languages"),
      button: z.string().default("Search"),
      devOnly: z
        .string()
        .default("Search is available in the production build."),
      label: z.string().default("Search docs"),
      noResults: z.string().default("No results found."),
      placeholder: z.string().default("Search documentation…"),
    })
    .default({}),
  toc: z
    .object({
      title: z.string().default("On this page"),
    })
    .default({}),
});

export const uiStringsSchema = uiStringsObject.default({});

/** A fully-resolved dictionary; every key present. */
export type UIStrings = z.infer<typeof uiStringsObject>;

/** The English baseline, derived from the schema defaults. */
export const EN_UI: UIStrings = uiStringsObject.parse({});

/**
 * A partial override: `{ group: { key: "translation" } }`. Validated loosely
 * (object of objects of strings) so packs and user config can supply only the
 * keys they translate. Unknown groups/keys merge harmlessly.
 */
export const uiStringsOverrideSchema = z.record(
  z.string(),
  z.record(z.string(), z.string())
);

export type UIStringsOverride = z.infer<typeof uiStringsOverrideSchema>;

/** Per-locale UI overrides supplied in `i18n.ui`. */
export const uiLocaleOverridesSchema = z.record(
  z.string(),
  uiStringsOverrideSchema
);

/** Merge an override's string leaves onto a base dictionary (two levels deep). */
const mergeUI = (base: UIStrings, override?: UIStringsOverride): UIStrings => {
  if (!override) {
    return base;
  }
  const out: UIStrings = structuredClone(base);
  for (const [group, values] of Object.entries(override)) {
    const target = (out as Record<string, Record<string, string>>)[group];
    if (target && values) {
      Object.assign(target, values);
    }
  }
  return out;
};

/**
 * Built-in translation packs, one module per locale under {@link ./ui-packs}.
 * English is the schema baseline (no pack); every other locale ships a starter
 * pack so adopters get translated chrome out of the box. Re-exported here so the
 * resolver and existing imports keep a single entry point.
 */
export { UI_PACKS };

/** Case-insensitive index for region-variant lookup (`pt-br` -> `pt-BR`). */
const PACKS_BY_LOWER: Record<string, UIStringsOverride> = Object.fromEntries(
  Object.entries(UI_PACKS).map(([code, pack]) => [code.toLowerCase(), pack])
);

/**
 * Find the built-in pack for a locale code, tolerating case and region subtags:
 * an exact match wins, then a case-insensitive match (`pt-br` -> `pt-BR`), then
 * the base language (`fr-CA` -> `fr`). So any reasonable code gets sensible
 * chrome without the project having to match our exact casing.
 */
const packFor = (code: string): UIStringsOverride | undefined => {
  const lower = code.toLowerCase();
  return (
    UI_PACKS[code] ??
    PACKS_BY_LOWER[lower] ??
    PACKS_BY_LOWER[lower.split(/[-_]/u)[0] ?? lower]
  );
};

/**
 * Resolve the active dictionary for a locale. Layers, in order:
 * English baseline ← default-locale pack ← default-locale override ←
 * locale pack ← locale override. So a missing key falls back to the default
 * locale's translation, then to English.
 */
export const resolveUIStrings = (
  locale: string,
  options: {
    defaultLocale: string;
    overrides?: Record<string, UIStringsOverride>;
  }
): UIStrings => {
  const { defaultLocale, overrides } = options;
  let dict = EN_UI;
  dict = mergeUI(dict, packFor(defaultLocale));
  dict = mergeUI(dict, overrides?.[defaultLocale]);
  if (locale !== defaultLocale) {
    dict = mergeUI(dict, packFor(locale));
    dict = mergeUI(dict, overrides?.[locale]);
  }
  return dict;
};
