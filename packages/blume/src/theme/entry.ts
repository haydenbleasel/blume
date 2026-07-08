interface TailwindEntryOptions {
  /**
   * Globs to scan for utility classes. Typically the Blume package source and
   * the user's project (node_modules is skipped automatically).
   */
  sources: string[];
  /** Config-derived token overrides (`:root { --blume-accent: ... }`). */
  configTokens: string;
  /** Raw contents of the user's theme.css, if any. */
  userTheme: string;
  /** Twoslash rich-renderer styles (for fences with the `twoslash` meta). */
  twoslashCss?: string;
}

/** Dark mode is driven by `data-theme` on the root element (both sheets). */
const DARK_VARIANT = `/* Dark mode is driven by data-theme on the <html> element. */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));`;

/**
 * The default `--blume-*` design tokens (light + dark), shared by the app
 * sheet and the isolated example-preview sheet so previews inherit the site's
 * palette by default.
 */
const TOKEN_DEFAULTS = `:root {
  --blume-background: oklch(1 0 0);
  --blume-background-image: none;
  --blume-background-image-repeat: no-repeat;
  --blume-background-image-size: cover;
  --blume-foreground: oklch(0.145 0 0);
  --blume-muted: oklch(0.965 0 0);
  --blume-muted-foreground: oklch(0.54 0 0);
  --blume-border: oklch(0.88 0.006 260 / 0.72);
  --blume-accent: oklch(0.145 0 0);
  --blume-accent-foreground: oklch(1 0 0);
  --blume-action: var(--blume-accent);
  --blume-action-foreground: var(--blume-accent-foreground);
  --blume-code-background: oklch(0.99 0 0);
  /* Shiki notation transformers: line/word highlight, diff add/remove. */
  --blume-code-highlight: oklch(0.55 0.16 255 / 0.1);
  --blume-code-highlight-border: oklch(0.55 0.16 255 / 0.55);
  --blume-code-add: oklch(0.72 0.16 150 / 0.16);
  --blume-code-add-border: oklch(0.52 0.15 150 / 0.7);
  --blume-code-remove: oklch(0.66 0.21 22 / 0.16);
  --blume-code-remove-border: oklch(0.55 0.2 22 / 0.7);
  --blume-code-word: oklch(0.55 0.16 255 / 0.16);
  --blume-code-word-border: oklch(0.55 0.16 255 / 0.5);
  --blume-radius: 0.75rem;

  /*
   * Font tokens resolve through optional src variables that Astro's Fonts API
   * populates (via theme.fonts). When unset they fall back to the system
   * stacks, so the default look is unchanged. The display font defaults to the
   * body font.
   */
  --blume-font-body: var(
    --blume-font-body-src,
    ui-sans-serif,
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    Helvetica,
    Arial,
    sans-serif
  );
  --blume-font-mono: var(
    --blume-font-mono-src,
    ui-monospace,
    "SF Mono",
    "Cascadia Code",
    "Source Code Pro",
    Menlo,
    Consolas,
    monospace
  );
  --blume-font-display: var(--blume-font-display-src, var(--blume-font-body));
}

:root[data-theme="dark"] {
  --blume-background: oklch(0.085 0 0);
  --blume-background-image: none;
  --blume-background-image-repeat: no-repeat;
  --blume-background-image-size: cover;
  --blume-foreground: oklch(0.96 0 0);
  --blume-muted: oklch(0.16 0 0);
  --blume-muted-foreground: oklch(0.68 0 0);
  --blume-border: oklch(0.24 0 0 / 0.8);
  --blume-accent: oklch(0.96 0 0);
  --blume-accent-foreground: oklch(0.085 0 0);
  --blume-action: var(--blume-accent);
  --blume-action-foreground: var(--blume-accent-foreground);
  --blume-code-background: oklch(0.12 0 0);
  /* Brighter tints read better over the dark code surface. */
  --blume-code-highlight: oklch(0.7 0.14 255 / 0.16);
  --blume-code-highlight-border: oklch(0.7 0.14 255 / 0.6);
  --blume-code-add: oklch(0.78 0.17 150 / 0.2);
  --blume-code-add-border: oklch(0.72 0.16 150 / 0.7);
  --blume-code-remove: oklch(0.72 0.21 22 / 0.22);
  --blume-code-remove-border: oklch(0.7 0.2 22 / 0.7);
  --blume-code-word: oklch(0.7 0.14 255 / 0.22);
  --blume-code-word-border: oklch(0.7 0.14 255 / 0.55);
}`;

/**
 * Tailwind theme mapping from `--blume-*` tokens to utility-facing names
 * (`bg-background`, `border-border`, `rounded-blume`, the font stacks).
 * Shared by both sheets so example code written against Blume's utility
 * vocabulary renders identically inside the isolated preview frame.
 */
const THEME_MAPPING = `@theme inline {
  --color-background: var(--blume-background);
  --color-foreground: var(--blume-foreground);
  --color-muted: var(--blume-muted);
  --color-muted-foreground: var(--blume-muted-foreground);
  --color-border: var(--blume-border);
  --color-accent: var(--blume-accent);
  --color-accent-foreground: var(--blume-accent-foreground);
  --color-action: var(--blume-action);
  --color-action-foreground: var(--blume-action-foreground);
  --color-code: var(--blume-code-background);
  --radius-blume: var(--blume-radius);
  --font-sans: var(--blume-font-body);
  --font-mono: var(--blume-font-mono);
  --font-display: var(--blume-font-display);
}`;

/**
 * Build the single Tailwind v4 entry stylesheet for the generated runtime.
 *
 * Everything flows through one Tailwind-processed file so utilities are
 * generated and design tokens cascade deterministically:
 * base defaults -> config tokens -> user theme.css.
 */
export const tailwindEntryTemplate = (options: TailwindEntryOptions): string =>
  `/* Generated by Blume. Do not edit. */
@import "tailwindcss";
@plugin "@tailwindcss/typography";

/* Scan Blume's components and the user's project for utility classes. */
${options.sources.map((source) => `@source "${source}";`).join("\n")}

${DARK_VARIANT}

${TOKEN_DEFAULTS}

${THEME_MAPPING}

@layer base {
  /* Nothing refuses to shrink below its intrinsic content width. This global
     min-width reset defuses the classic flex/grid overflow — a long or
     truncating child forcing its container (and the page) past the viewport
     edge — so components don't need per-element min-w-0 overrides. */
  * {
    min-width: 0;
  }
  /* Interactive controls get a pointer cursor unless disabled. */
  button:not(:disabled),
  [role="button"]:not(:disabled) {
    cursor: pointer;
  }
  html {
    scroll-behavior: smooth;
    scroll-padding-top: 4.5rem;
    text-rendering: optimizeLegibility;
  }
  /* Headings use the display font (defaults to the body font when unset). */
  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    font-family: var(--font-display);
  }
  :focus-visible {
    outline: 2px solid var(--blume-accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
  body {
    background-attachment: fixed;
    background-image: var(--blume-background-image);
    background-position: center top;
    background-repeat: var(--blume-background-image-repeat);
    background-size: var(--blume-background-image-size);
  }
  @media (prefers-reduced-motion: reduce) {
    html {
      scroll-behavior: auto;
    }
  }
}

/* Code reads left-to-right regardless of page direction; only the surrounding
   chrome mirrors for RTL. Inline code is isolated so LTR identifiers don't
   disturb the bidi flow of right-to-left prose. */
[dir="rtl"] pre,
[dir="rtl"] .prose pre {
  direction: ltr;
  text-align: left;
}
[dir="rtl"] :not(pre) > code {
  unicode-bidi: isolate;
}

/* Theme Tailwind Typography (prose) with Blume tokens. */
.prose {
  --tw-prose-body: var(--blume-foreground);
  --tw-prose-headings: var(--blume-foreground);
  --tw-prose-lead: var(--blume-muted-foreground);
  --tw-prose-links: var(--blume-foreground);
  --tw-prose-bold: var(--blume-foreground);
  --tw-prose-counters: var(--blume-muted-foreground);
  --tw-prose-bullets: var(--blume-border);
  --tw-prose-hr: var(--blume-border);
  --tw-prose-quotes: var(--blume-muted-foreground);
  --tw-prose-quote-borders: var(--blume-border);
  --tw-prose-captions: var(--blume-muted-foreground);
  --tw-prose-code: var(--blume-foreground);
  --tw-prose-pre-code: var(--blume-foreground);
  --tw-prose-pre-bg: var(--blume-code-background);
  --tw-prose-th-borders: var(--blume-border);
  --tw-prose-td-borders: var(--blume-border);
  color: var(--blume-muted-foreground);
  font-size: 0.875rem;
  line-height: 1.7;
}

.prose :where(h1, h2, h3, h4) {
  font-weight: 500;
  letter-spacing: 0;
}

.prose :where(h1) {
  font-size: 3rem;
  line-height: 1.1;
  margin: 0 0 1rem;
}

.prose :where(h2) {
  font-size: 1.875rem;
  line-height: 1.2;
  margin-top: 3rem;
}

.prose :where(h3) {
  font-size: 1.25rem;
  line-height: 1.35;
}

.prose :where(h4) {
  color: var(--blume-muted-foreground);
  font-size: 0.875rem;
  line-height: 1.4;
}

.prose :where(h1, h2, h3, h4, h5, h6) a {
  color: inherit;
  font-weight: inherit;
  text-decoration: none;
}

/* Auto-generated heading permalinks (markdown.headingAnchors): the whole
   heading links to its own id, with a muted “#” revealed on hover or keyboard
   focus so the link is discoverable without cluttering the heading at rest. */
.prose :where(h2, h3, h4, h5, h6) a.blume-heading-anchor::after {
  content: "#";
  color: var(--blume-muted-foreground);
  margin-inline-start: 0.35em;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.prose :where(h2, h3, h4, h5, h6) a.blume-heading-anchor:hover::after,
.prose :where(h2, h3, h4, h5, h6) a.blume-heading-anchor:focus-visible::after {
  opacity: 1;
}

.prose :where(h2:first-child) {
  border-top: 0;
  padding-top: 0;
}

.prose :where(p, ul, ol) {
  margin-top: 1rem;
  margin-bottom: 1rem;
}

.prose :where(strong) {
  font-weight: 600;
}

.prose :where(a) {
  color: var(--blume-foreground);
  font-weight: 500;
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.2em;
}

.prose :where(a[data-blume-card]) {
  color: inherit;
  font-weight: inherit;
  text-decoration: none;
}

.prose :where(hr) {
  margin: 2.5rem 0;
}

.prose :where(pre) {
  background: transparent;
  border: 1px solid var(--blume-border);
  border-radius: var(--blume-radius);
  color: var(--blume-foreground);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  line-height: 1.55;
  margin: 1.5rem 0;
  overflow-x: auto;
  padding: 1rem 0;
  position: relative;
}

.prose :where(pre.astro-code) {
  background: transparent !important;
  color: var(--shiki-light, var(--blume-foreground)) !important;
}

:root[data-theme="dark"] .prose :where(pre.astro-code) {
  color: var(--shiki-dark, var(--blume-foreground)) !important;
}

.prose :where(pre.astro-code span) {
  background: transparent !important;
  color: var(--shiki-light, inherit);
  font-style: var(--shiki-light-font-style, inherit);
  font-weight: var(--shiki-light-font-weight, inherit);
  text-decoration: var(--shiki-light-text-decoration, inherit);
}

:root[data-theme="dark"] .prose :where(pre.astro-code span) {
  color: var(--shiki-dark, inherit);
  font-style: var(--shiki-dark-font-style, inherit);
  font-weight: var(--shiki-dark-font-weight, inherit);
  text-decoration: var(--shiki-dark-text-decoration, inherit);
}

/* The Diff component (@pierre/diffs) renders into a declarative shadow root and
   themes itself with light-dark(). Drive that from Blume's data-theme instead
   of the OS, scoped to the diff host: the custom property pierces the shadow
   boundary, where the appended host color-scheme rule consumes it. */
blume-diff {
  --blume-diff-color-scheme: light;
  display: block;
}

:root[data-theme="dark"] blume-diff {
  --blume-diff-color-scheme: dark;
}

.prose :where(pre[data-language]) {
  padding-top: 3.75rem;
}

.prose :where(pre[data-language])::before {
  align-items: center;
  border-bottom: 1px solid var(--blume-border);
  color: var(--blume-muted-foreground);
  content: attr(data-language);
  display: flex;
  font-family: var(--font-sans);
  font-size: 0.75rem;
  font-weight: 500;
  height: 2.75rem;
  left: 0;
  padding: 0 3.25rem 0 1rem;
  position: absolute;
  right: 0;
  top: 0;
}

.prose :where(pre[data-title])::before {
  content: attr(data-title);
}

/* Language icon (simple-icons) sits at the header's left edge; the label shifts
   right to make room. Injected at build time by the language-icon transformer.
   Shown only for top-level prose blocks, which have a header — flush code in
   tabs and API panels is nested deeper, so the child combinator skips it. */
.blume-lang-icon {
  display: none;
}

.prose > :where(pre[data-icon]) > .blume-lang-icon {
  color: var(--blume-muted-foreground);
  display: block;
  height: 0.875rem;
  left: 1rem;
  position: absolute;
  top: 0.875rem;
  width: 0.875rem;
}

.prose > :where(pre[data-icon])::before {
  padding-left: 2.5rem;
}

.prose :where(pre code) {
  background: transparent;
  border-radius: 0;
  color: inherit;
  font-size: inherit;
  font-weight: 400;
  padding: 0;
}

/* Long lines scroll inside the code element, not the pre: the pre stays static
   so its absolute header bar (::before) and copy button don't drift with the
   scroll. The pre's horizontal padding lives here so content still scrolls
   edge-to-edge past it. Two contexts opt out: twoslash blocks (popups must
   escape any scroll container — see theme/twoslash.ts), and the API request
   panel, which owns its code layout and keeps the copy control in the panel
   header. Every other component that hosts a code block — Tabs, CodeGroup,
   Steps, Callout, Card, Accordion — is real prose content and keeps the inset,
   even though its chrome wrapper is not-prose. */
.prose :where(pre:not(.twoslash, .twoslash pre, blume-panel-tabs *) > code) {
  display: block;
  overflow-x: auto;
  padding: 0 1.25rem;
  /* The scroller is only as tall as the code, so an overlay scrollbar would
     draw on top of the last line; hide it (wheel/trackpad/keyboard scrolling
     still works). */
  scrollbar-width: none;
}

.prose
  :where(
    pre:not(.twoslash, .twoslash pre, blume-panel-tabs *) > code
  )::-webkit-scrollbar {
  display: none;
}

/* Word wrap (markdown.code.wrap): long lines wrap instead of scrolling. The
   attribute is set on <body> from config; default code keeps \`white-space: pre\`. */
[data-blume-code-wrap] pre,
[data-blume-code-wrap] pre code {
  overflow-wrap: break-word;
  white-space: pre-wrap;
}

.prose :where(table) {
  font-size: 0.8125rem;
}

/* GFM renders cells as <td><code> directly, which the descendant form alone
   never matches (a cell is not its own descendant). */
.prose :where(td, th) > code,
.prose :where(td, th) :not(pre) > code {
  white-space: nowrap;
}

blume-tabs pre,
.not-prose > div > pre {
  background: var(--blume-code-background);
}

/* The Component source pane fills its tab's fixed height (set inline to match the
   preview tab) and scrolls the inner code element, leaving the pre static so the
   copy button — absolute, pinned to the pre — doesn't drift while it scrolls. */
pre.blume-source {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

pre.blume-source > code {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* Code blocks inside tabs sit flush; the tab container owns the frame. These
   rules are unlayered like the base \`pre\` styles, so they win over Tailwind's
   layered utilities (which a class on the panel cannot). The second selector
   covers <CodeGroup>, where each code block IS the panel (a direct child of the
   tab content wrapper) rather than a <pre> nested inside a <Tab>. */
blume-tabs [data-blume-tab-panel] > pre,
blume-tabs [data-blume-tab-content] > pre {
  /* Important to beat the astro-code background rule above; the tab container
     owns the surface, so the code sits directly on it. */
  background: transparent !important;
  border: 0;
  border-radius: 0;
  margin: 0;
}

blume-tabs pre[data-language],
.not-prose pre[data-language] {
  padding-top: 1rem;
}

blume-tabs pre[data-language]::before,
.not-prose pre[data-language]::before {
  content: none;
}

/* Pre-hydration layout-shift guard. The horizontal trigger row and
   single-panel visibility are built by the <blume-tabs> custom element's JS:
   until it upgrades, the trigger row is empty and every panel is in normal flow,
   so the browser paints all panels stacked vertically (e.g. all four
   package-manager commands at once) before JS hides them. While the element is
   :not(:defined), show only the first panel and reserve the trigger row's height
   so nothing jumps when JS takes over. The child selector covers both <Tab>
   panels and <CodeGroup> raw code blocks (which only gain
   [data-blume-tab-panel] from JS). */
blume-tabs:not(:defined) [data-blume-tab-content] > *:nth-child(n + 2) {
  display: none;
}

blume-tabs:not(:defined) [data-blume-tablist] {
  /* Matches a trigger's height: py-2.5 + text-xs line-height + border-b-2. */
  min-height: 2.375rem;
}

blume-tabs:not(:defined)[data-dropdown="true"] [data-blume-tablist] {
  /* Dropdown variant: p-3 padding around a select (py-2 + text-sm + border). */
  min-height: 3.875rem;
}

/* Code blocks inside request/response example panels sit flush; the panel owns
   the frame. Unlayered (like the tab rules) so they beat the base \`pre\` styles
   that a class on the panel cannot. */
[data-blume-code-panel] pre {
  background: transparent !important;
  border: 0;
  border-radius: 0;
  margin: 0;
}

/* Opt-in line numbers (\`\`\`ts file.ts lineNumbers): a counter-driven gutter that
   works in prose and flush (tab / API panel) code blocks alike. */
pre[data-line-numbers] code {
  counter-reset: line;
}

pre[data-line-numbers] .line::before {
  color: var(--blume-muted-foreground);
  content: counter(line);
  counter-increment: line;
  display: inline-block;
  margin-right: 1.25rem;
  text-align: right;
  user-select: none;
  width: 1.25rem;
}

/* Shiki notation transformers (on by default). The notation comments are
   stripped from the output; these style the classes they leave behind. A styled
   line becomes a full-width inline-block so its background fills the row; plain
   lines are left untouched, so blocks without notations render as before. */
.line.highlighted,
.line.diff {
  display: inline-block;
  width: 100%;
}

/* The backgrounds need !important to beat the \`pre.astro-code span\` rule above,
   which forces token spans transparent; these line/word spans are exceptions. */
.line.highlighted {
  background-color: var(--blume-code-highlight) !important;
  box-shadow: inset 2px 0 0 0 var(--blume-code-highlight-border);
}

.line.diff.add {
  background-color: var(--blume-code-add) !important;
  box-shadow: inset 2px 0 0 0 var(--blume-code-add-border);
}

.line.diff.remove {
  background-color: var(--blume-code-remove) !important;
  box-shadow: inset 2px 0 0 0 var(--blume-code-remove-border);
}

/* Word highlight (\`// [!code word:x]\`) wraps matches in an inline span. The
   element selector keeps it ahead of the transparent token-span rule. */
span.highlighted-word {
  background-color: var(--blume-code-word) !important;
  border-radius: 0.25rem;
  box-shadow: 0 0 0 1px var(--blume-code-word-border);
  padding: 0.1em 0.2em;
}

/* Focus (\`// [!code focus]\`): dim and blur the rest; reveal on hover. */
pre:has(.line.focused) .line:not(.focused) {
  filter: blur(0.085rem);
  opacity: 0.5;
  transition:
    filter 0.2s ease,
    opacity 0.2s ease;
}

pre:has(.line.focused):hover .line:not(.focused) {
  filter: none;
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  pre:has(.line.focused) .line:not(.focused) {
    transition: none;
  }
}

@media (max-width: 640px) {
  .prose :where(h1) {
    font-size: 2.25rem;
  }

  .prose :where(h2) {
    font-size: 1.625rem;
  }
}

.prose :not(pre) > code:not(:where([class~="not-prose"] *)) {
  background: var(--blume-code-background);
  padding: 0.15em 0.35em;
  border-radius: 0.3rem;
  font-family: var(--font-mono);
  font-weight: 500;
}

.prose :not(pre) > code::before,
.prose :not(pre) > code::after {
  content: none;
}

/* Inline code highlighting: Shiki colors the tokens of a \`code\`{:lang} snippet
   via the same dual-theme CSS variables as fenced blocks, keeping the inline
   pill background. Always on — it only fires on the trailing {:lang} marker. */
.prose code.blume-inline-code span {
  color: var(--shiki-light);
}

:root[data-theme="dark"] .prose code.blume-inline-code span {
  color: var(--shiki-dark);
}

/* Print / "Save as PDF" (the page-actions Export → PDF runs window.print()).
   Strip the surrounding chrome so the printout is just the article. */
@media print {
  [data-blume-banner],
  header,
  aside,
  [data-blume-page-actions],
  #blume-content > nav,
  #blume-content > details {
    display: none !important;
  }

  #blume-content {
    padding: 0 !important;
  }

  .prose {
    margin: 0 !important;
    max-width: none !important;
  }

  /* Reveal collapsed tab panels so their content isn't dropped from the print. */
  blume-tabs [data-blume-tab-panel] {
    display: block !important;
  }

  /* Keep code/callout backgrounds (subject to the dialog's "Background graphics"
     toggle). */
  pre,
  .prose :not(pre) > code {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}

/* Twoslash rich-renderer styles (used by fences with the \`twoslash\` meta). */
${options.twoslashCss ?? ""}

/* Token overrides: config first, then the user's theme.css (highest priority). */
${options.configTokens}
${options.userTheme}
`;

interface ExamplesEntryOptions {
  /** Config-derived token overrides (`:root { --blume-accent: ... }`). */
  configTokens: string;
  /** Globs to scan for utility classes (example files and their imports). */
  sources: string[];
  /** Raw contents of the configured `examples.css`, if any. */
  userCss: string;
}

/**
 * Build the Tailwind entry for `<Component />` preview frames. Each example
 * renders in its own iframe so none of the app sheet above — prose typography,
 * component chrome, base overrides — can reach it. This sheet provides only
 * what an example needs to look like it does in an app: Tailwind (preflight +
 * utilities scanned from the example sources), the `--blume-*` tokens and
 * their utility mapping (so `bg-background`-style classes keep working and
 * previews follow the site palette by default), and the user's example CSS
 * (shadcn variables, `@theme` mappings, custom styles) last so it wins.
 */
export const examplesEntryTemplate = (options: ExamplesEntryOptions): string =>
  `/* Generated by Blume. Do not edit. */
@import "tailwindcss";

/* Scan the example files and the project sources they import. */
${options.sources.map((source) => `@source "${source}";`).join("\n")}

${DARK_VARIANT}

${TOKEN_DEFAULTS}

${THEME_MAPPING}

/* Frame defaults: readable text in both modes, transparent so the docs pane's
   surface shows through. Base layer, so any user/example CSS wins. */
@layer base {
  body {
    background: transparent;
    color: var(--blume-foreground);
  }
}

/* Token overrides: config first, then the configured examples css (highest
   priority) — the place for shadcn variables and other component tokens. */
${options.configTokens}
${options.userCss}
`;
