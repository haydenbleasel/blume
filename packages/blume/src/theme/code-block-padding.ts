/**
 * Vertical padding of a highlighted code block, shared by the theme (which
 * emits it as CSS) and `<Component>` (which estimates a source pane's SSR
 * height from it) so the two cannot drift.
 */

/** Top and bottom inset of a plain prose block with no chrome, in rem. */
export const CODE_PADDING_BLOCK_REM = 1;

/**
 * Top inset of a flush block — inside tabs or a `not-prose` component, or an
 * untitled block with no language bar — where the layout's copy button is
 * absolutely positioned over the first line: `top-2.5` plus a 1.875rem button
 * lands at 2.5rem, so the first line starts there.
 */
export const FLUSH_CODE_PADDING_TOP_REM = 2.5;
