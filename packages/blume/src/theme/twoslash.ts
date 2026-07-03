/**
 * CSS for Twoslash's rich renderer, emitted into the Tailwind entry (Twoslash
 * runs on any fence with the `twoslash` meta). It is the shipped
 * `@shikijs/twoslash` stylesheet plus a Blume-themed override layer:
 *
 * - maps the renderer's `--twoslash-*` variables onto Blume tokens so popups
 *   match the active theme (light/dark);
 * - lets popups escape the code block's horizontal scroll container; and
 * - restores backgrounds the theme's `pre.astro-code span { background:
 *   transparent !important }` rule would otherwise clear from popup chrome.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Blume-token theming layered over the shipped rich renderer styles. */
const OVERRIDES = `
/* Twoslash: theme the rich renderer with Blume tokens. */
:root {
  --twoslash-border-color: var(--blume-border);
  --twoslash-popup-bg: var(--blume-code-background);
  --twoslash-popup-color: var(--blume-foreground);
  --twoslash-popup-shadow: 0 6px 24px oklch(0 0 0 / 0.18);
  --twoslash-docs-color: var(--blume-muted-foreground);
  --twoslash-docs-font: var(--font-sans);
  --twoslash-code-font: var(--font-mono);
  --twoslash-matched-color: var(--blume-foreground);
  --twoslash-unmatched-color: var(--blume-muted-foreground);
  --twoslash-cursor-color: var(--blume-muted-foreground);
}

/* Popups are absolutely positioned and must escape the pre's scroll container.
   The base prose pre rule (from the typography layer) wins the cascade here
   despite lower specificity, so !important is needed to force visibility.
   Regular code blocks scroll their inner code element and carry the horizontal
   padding there; twoslash code opts out of that scroller (popups again), so the
   padding is restored on the pre. */
.prose pre.twoslash {
  overflow: visible !important;
  padding-left: 1.25rem;
  padding-right: 1.25rem;
}

/* The rich renderer renders each popup's type signature as a nested Shiki
   pre. Strip the code-block chrome (border, radius, padding, background) so it
   sits flush inside the popup, which owns the frame. */
.prose pre.twoslash .twoslash-popup-container pre {
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
}

/* Re-assert chrome backgrounds the transparent token-span rule would clear. */
.twoslash .twoslash-popup-container,
.twoslash .twoslash-popup-arrow,
.twoslash .twoslash-completion-cursor .twoslash-completion-list {
  background: var(--twoslash-popup-bg) !important;
}
.twoslash .twoslash-popup-error {
  background: var(--twoslash-error-bg) !important;
}
.twoslash .twoslash-highlighted {
  background: var(--twoslash-highlighted-bg) !important;
}

/* The error squiggle uses a background image the transparent rule clears, so
   draw it as a wavy underline instead. */
.twoslash .twoslash-error {
  text-decoration: underline wavy var(--twoslash-error-color);
  text-underline-offset: 0.25em;
}

.twoslash-popup-container {
  max-width: min(90vw, 36rem);
}
`;

/** The full Twoslash stylesheet (shipped rich styles + Blume overrides). */
export const twoslashCss = (): string => {
  const file = require.resolve("@shikijs/twoslash/style-rich.css");
  return `${readFileSync(file, "utf-8")}\n${OVERRIDES}`;
};
