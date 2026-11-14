import { slug } from "github-slugger";

/**
 * Slug a component's title into a DOM id (accordions, tabs, changelog
 * updates), replacing three identical per-component copies. github-slugger —
 * already what heading anchors use, both here and in Satteri's own
 * heading-ids — so a component id slugs exactly like a heading with the same
 * text (unicode letters kept, `user_id` keeps its underscore, `C#` keeps
 * nothing extra dropped). Stateless on purpose: components render across many
 * pages in one build process, so a stateful slugger would leak duplicate
 * suffixes between pages — same-page duplicates are de-duplicated client-side
 * by each component's own script.
 */
export const componentSlug = (value: string): string => slug(value);

/**
 * The anchor an accordion item or a tab answers to: its `id`, or else its
 * title slugged. `blume validate` reads the same rule
 * (`core/component-anchors.ts`), so links it accepts are the ones that open.
 */
export const componentAnchorId = (
  id: string | undefined,
  title: string
): string => id ?? componentSlug(title);
