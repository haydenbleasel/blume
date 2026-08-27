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
      copyCode: z.string().default("Copy code"),
      copyCodex: z.string().default("Copy Codex command"),
      copyMarkdown: z.string().default("Copy as Markdown"),
      copyServerUrl: z.string().default("Copy server URL"),
      edit: z.string().default("Edit on GitHub"),
      export: z.string().default("Export"),
      exportEpub: z.string().default("Export to EPUB"),
      exportPdf: z.string().default("Export to PDF"),
      generating: z.string().default("Generating…"),
      // `{name}` is replaced with the provider's brand name at render time.
      openIn: z.string().default("Open in {name}"),
      openInChat: z.string().default("Open in chat"),
      // The prompt handed to the chat provider; `{url}` is replaced with the
      // page's raw-Markdown URL at load time.
      openInChatPrompt: z
        .string()
        .default("Read {url} so I can ask you questions about this page."),
      scrollToTop: z.string().default("Scroll to top"),
    })
    .prefault({}),
  ask: z
    .object({
      ai: z.string().default("AI"),
      clear: z.string().default("Clear conversation"),
      close: z.string().default("Close"),
      copy: z.string().default("Copy conversation"),
      empty: z.string().default("Ask a question about the docs."),
      error: z.string().default("Sorry, something went wrong."),
      label: z.string().default("Ask a question"),
      placeholder: z.string().default("Ask a question…"),
      send: z.string().default("Send"),
      tip: z.string().default("Tip: You can open and close chat with"),
      title: z.string().default("Ask AI"),
      you: z.string().default("You"),
    })
    .prefault({}),
  banner: z
    .object({
      dismiss: z.string().default("Dismiss announcement"),
    })
    .prefault({}),
  changelog: z
    .object({
      description: z
        .string()
        .default(
          "Product updates, new features, and fixes from every release."
        ),
      // `{version}` is replaced with the major line ("2.x") at render time.
      showReleases: z.string().default("Show {version} releases"),
      title: z.string().default("Changelog"),
    })
    .prefault({}),
  content: z
    .object({
      diagramError: z.string().default("Could not render this diagram."),
    })
    .prefault({}),
  feedback: z
    .object({
      no: z.string().default("No"),
      question: z.string().default("Was this page helpful?"),
      thanks: z.string().default("Thanks for your feedback!"),
      yes: z.string().default("Yes"),
    })
    .prefault({}),
  languageSwitcher: z
    .object({
      label: z.string().default("Language"),
      untranslated: z.string().default("Not translated"),
    })
    .prefault({}),
  nav: z
    .object({
      back: z.string().default("Back"),
      breadcrumb: z.string().default("Breadcrumb"),
      closeNavigation: z.string().default("Close navigation"),
      deprecated: z.string().default("deprecated"),
      featured: z.string().default("Featured"),
      githubRepository: z.string().default("GitHub repository"),
      navigation: z.string().default("Navigation"),
      primary: z.string().default("Primary"),
      sections: z.string().default("Sections"),
      toggleNavigation: z.string().default("Toggle navigation"),
      toggleTheme: z.string().default("Toggle color theme"),
    })
    .prefault({}),
  notFound: z
    .object({
      description: z
        .string()
        .default("We couldn't find the page you're looking for."),
      home: z.string().default("Back to home"),
      /** Label of the llms.txt link on the 404 page. */
      llms: z.string().default("Docs index for AI agents (llms.txt)"),
      /** Label of the sitemap link on the 404 page. */
      sitemap: z.string().default("Sitemap"),
      /** Heading over the recovery links (sections, sitemap, llms.txt). */
      suggestions: z.string().default("Where to look next"),
      title: z.string().default("Page not found"),
    })
    .prefault({}),
  page: z
    .object({
      lastUpdated: z.string().default("Last updated on"),
      next: z.string().default("Next"),
      pagination: z.string().default("Pagination"),
      previous: z.string().default("Previous"),
      skipToContent: z.string().default("Skip to content"),
    })
    .prefault({}),
  search: z
    .object({
      all: z.string().default("All"),
      allLanguages: z.string().default("All languages"),
      allVersions: z.string().default("All versions"),
      askAi: z.string().default("Ask AI"),
      askAiHint: z.string().default("Get an instant answer from AI"),
      button: z.string().default("Search"),
      devOnly: z
        .string()
        .default("Search is available in the production build."),
      error: z.string().default("Something went wrong. Please try again."),
      label: z.string().default("Search docs"),
      navigate: z.string().default("navigate"),
      noResults: z.string().default("No results found."),
      open: z.string().default("open"),
      placeholder: z.string().default("Search documentation…"),
      popular: z.string().default("Popular"),
      preview: z.string().default("preview"),
      results: z.string().default("Results"),
    })
    .prefault({}),
  toc: z
    .object({
      title: z.string().default("On this page"),
    })
    .prefault({}),
  versions: z
    .object({
      latest: z.string().default("Go to latest"),
      // `{version}` is replaced with the archived version's label at render time.
      notice: z
        .string()
        .default(
          "You're viewing documentation for {version}. It may be out of date."
        ),
      switcher: z.string().default("Version"),
    })
    .prefault({}),
});

export const uiStringsSchema = uiStringsObject.prefault({});

/** A fully-resolved dictionary; every key present. */
export type UIStrings = z.infer<typeof uiStringsObject>;

/**
 * The English baseline, derived from the schema defaults. The groups use
 * `.prefault({})` (not `.default({})`) so an absent group is still parsed
 * through its inner type and every field default applies — under Zod 4's
 * `.default()` semantics a bare `parse({})` would collapse each group to a
 * literal `{}` and the runtime would silently render blank chrome.
 */
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
    // SAFETY: UIStrings is exactly two levels of string leaves, and the
    // override schema mirrors its groups, so `group` indexes a string map.
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
export { UI_PACKS } from "./ui-packs/index.ts";

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
