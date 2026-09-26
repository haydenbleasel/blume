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
      // A code block's button that opens the assistant with the code attached.
      askAboutCode: z.string().default("Ask about this code"),
      connectMcp: z.string().default("Connect to MCP"),
      copied: z.string().default("Copied!"),
      copyClaudeCode: z.string().default("Copy Claude Code command"),
      copyCode: z.string().default("Copy code"),
      copyCodex: z.string().default("Copy Codex command"),
      copyFailed: z.string().default("Copy failed"),
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
  assistant: z
    .object({
      ai: z.string().default("AI"),
      clear: z.string().default("Clear conversation"),
      close: z.string().default("Close"),
      copy: z.string().default("Copy conversation"),
      empty: z.string().default("Ask a question about the docs."),
      error: z.string().default("Sorry, something went wrong."),
      // The question sent about an attached code block when the reader
      // writes none.
      explainCode: z.string().default("Explain this code."),
      label: z.string().default("Ask a question"),
      // The header trigger's tooltip.
      open: z.string().default("Open assistant"),
      placeholder: z.string().default("Ask a question…"),
      // The answer when the rate limit (`rateLimit`) turns a question away.
      rateLimited: z
        .string()
        .default(
          "You've asked a lot of questions. Try again in a few minutes."
        ),
      // The attached code block's dismiss button.
      removeCode: z.string().default("Remove code"),
      send: z.string().default("Send"),
      // The link to your support channel (`ai.assistant.support`), and the
      // subject of an email it starts.
      support: z.string().default("Contact support"),
      supportSubject: z.string().default("Question from the docs"),
      tip: z.string().default("Tip: You can open and close chat with"),
      title: z.string().default("Assistant"),
      // The answer when the bot check (`ai.assistant.captcha`) fails.
      verifyFailed: z
        .string()
        .default("We couldn't check that you're human. Try again."),
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
      title: z.string().default("Changelog"),
    })
    .prefault({}),
  // The built-in cookie consent banner (`consent: native()`) and the footer
  // link that reopens a consent manager's preferences.
  consent: z
    .object({
      accept: z.string().default("Accept"),
      decline: z.string().default("Decline"),
      // The banner's accessible name.
      label: z.string().default("Cookie consent"),
      message: z
        .string()
        .default(
          "We'd like to use cookies to understand how these docs are used."
        ),
      policy: z.string().default("Privacy policy"),
      settings: z.string().default("Cookie settings"),
    })
    .prefault({}),
  content: z
    .object({
      // `<Component>`'s source tab.
      code: z.string().default("Code"),
      // A `<Color.Item>` swatch's accessible name; `{name}` and `{value}` are
      // replaced with the color's name and the value it shows.
      copyColor: z.string().default("Copy {name} color {value}"),
      copyPrompt: z.string().default("Copy prompt"),
      // `<TypeTable>`: a row's default-value label.
      default: z.string().default("Default"),
      diagramError: z.string().default("Could not render this diagram."),
      // `<GithubInfo>`: the screen-reader labels of the fork and star counts.
      forks: z.string().default("Forks"),
      // `<Component>`'s live-preview tab, also its frame's title.
      preview: z.string().default("Preview"),
      // `<TypeTable>`: the property-name column.
      prop: z.string().default("Prop"),
      // `<Tabs dropdown>`: the accessible name of the tab picker.
      selectTab: z.string().default("Select tab"),
      // `<View>`: the accessible name of the page's view picker.
      selectView: z.string().default("Select view"),
      // An expanded `expandable` code block's toggle.
      showLess: z.string().default("Show less"),
      // `<Expandable>`'s toggle when it sets no `title`, and a collapsed
      // `expandable` code block's.
      showMore: z.string().default("Show more"),
      stars: z.string().default("Stars"),
      // An untitled tab's label; `{n}` is replaced with its position.
      tab: z.string().default("Tab {n}"),
      // `<TypeTable>`: the type column and a row's type label.
      type: z.string().default("Type"),
      // `<Update>`'s heading when it sets no `label` or `title`.
      update: z.string().default("Update"),
    })
    .prefault({}),
  feedback: z
    .object({
      // The written comment box after the rating (`feedback.comments`).
      comment: z.string().default("Tell us more (optional)"),
      no: z.string().default("No"),
      question: z.string().default("Was this page helpful?"),
      send: z.string().default("Send"),
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
  narration: z
    .object({
      // Spoken, not shown: the cues that introduce a callout of each type, a
      // step (`{n}` is its number), a tab (`{title}` is its label), and a
      // collapsible section. End each with a full stop so it reads as its own
      // sentence.
      cueDanger: z.string().default("Danger."),
      cueInfo: z.string().default("Info."),
      cueNote: z.string().default("Note."),
      cueSection: z.string().default("Expandable section."),
      cueStep: z.string().default("Step {n}."),
      cueSuccess: z.string().default("Success."),
      cueTab: z.string().default("{title} tab."),
      cueTip: z.string().default("Tip."),
      cueWarning: z.string().default("Warning."),
      error: z.string().default("The narration couldn't load."),
      // Resumes following the sentence being read after the reader scrolls away.
      follow: z.string().default("Follow along"),
      label: z.string().default("Listen to this page"),
      // The estimated listening time; `{n}` is whole minutes.
      minutes: z.string().default("{n} min"),
      next: z.string().default("Next sentence"),
      pause: z.string().default("Pause"),
      play: z.string().default("Play"),
      previous: z.string().default("Previous sentence"),
      progress: z.string().default("Narration progress"),
      speed: z.string().default("Playback speed"),
      stop: z.string().default("Stop listening"),
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
      // The screen-reader description every new-tab link points at.
      opensInNewTab: z.string().default("Opens in a new tab"),
      primary: z.string().default("Primary"),
      sections: z.string().default("Sections"),
      toggleNavigation: z.string().default("Toggle navigation"),
      toggleTheme: z.string().default("Toggle theme"),
    })
    .prefault({}),
  notFound: z
    .object({
      /** Label of the OpenAPI description link on the Markdown/JSON 404. */
      api: z.string().default("JSON API description (openapi.json)"),
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
      // The heading over a page's `related` links.
      related: z.string().default("Related pages"),
      skipToContent: z.string().default("Skip to content"),
    })
    .prefault({}),
  search: z
    .object({
      all: z.string().default("All"),
      allLanguages: z.string().default("All languages"),
      allVersions: z.string().default("All versions"),
      assistant: z.string().default("Assistant"),
      assistantHint: z.string().default("Get an instant answer from AI"),
      button: z.string().default("Search"),
      devOnly: z
        .string()
        .default("Search is available in the production build."),
      // The section a hit falls under when its page sits in no sidebar group.
      docs: z.string().default("Docs"),
      error: z.string().default("Something went wrong. Please try again."),
      label: z.string().default("Search docs"),
      // The version tag on a result from the current docs in an all-versions
      // search (a result from an archived version shows its version id).
      latest: z.string().default("latest"),
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

/**
 * UI string keys renamed when Ask AI became the assistant, as `group` or
 * `group.key`, each with its new name. Unknown keys merge harmlessly, so an
 * override under an old name would otherwise be dropped without a word.
 */
const RENAMED_UI_KEYS = new Map([
  ["ask", "assistant"],
  ["search.askAi", "search.assistant"],
  ["search.askAiHint", "search.assistantHint"],
]);

/** Per-locale UI overrides supplied in `i18n.ui`. */
export const uiLocaleOverridesSchema = z
  .record(z.string(), uiStringsOverrideSchema)
  .superRefine((value, ctx) => {
    for (const [locale, override] of Object.entries(value)) {
      const keys = Object.entries(override).flatMap(([group, strings]) => [
        group,
        ...Object.keys(strings).map((key) => `${group}.${key}`),
      ]);
      for (const key of keys) {
        const renamed = RENAMED_UI_KEYS.get(key);
        if (renamed) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `i18n.ui.${locale}.${key} was renamed to i18n.ui.${locale}.${renamed}.`,
            path: [locale, ...key.split(".")],
          });
        }
      }
    }
  });

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

/** Whether a locale code is English (`en`, `en-GB`, `en_US`), in any case. */
const isEnglish = (code: string): boolean =>
  code.toLowerCase().split(/[-_]/u)[0] === "en";

/**
 * Resolve the active dictionary for a locale. Layers, in order:
 * English baseline ← default-locale pack ← default-locale override ←
 * locale pack ← locale override. So a missing key falls back to the default
 * locale's translation, then to English.
 *
 * English has no pack because the baseline is its complete translation, so an
 * English locale (`en`, `en-GB`) skips the default-locale layers: on a site
 * whose default is German, English pages keep English chrome instead of
 * inheriting the German strings.
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
  if (!isEnglish(locale) || isEnglish(defaultLocale)) {
    dict = mergeUI(dict, packFor(defaultLocale));
    dict = mergeUI(dict, overrides?.[defaultLocale]);
  }
  if (locale !== defaultLocale) {
    dict = mergeUI(dict, packFor(locale));
    dict = mergeUI(dict, overrides?.[locale]);
  }
  return dict;
};
