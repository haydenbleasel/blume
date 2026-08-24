/**
 * The shared fence-meta grammar: how the tokens after a code fence's language
 * (```ts title="..." {1,3-5} lineNumbers) split, and which of them carry
 * reserved meaning. Both the Shiki-side meta reader (`code-title.ts`) and the
 * MDAST plugins that rewrite marked fences (`ts2js.ts`) consume this, so the
 * two layers can't drift on token boundaries or keyword lists.
 */

/**
 * Any quoted `key="..."` attr (spaces allowed inside the quotes). The body
 * excludes only the delimiting quote, so `title="foo's file.ts"` (an
 * apostrophe inside double quotes) still matches. The left boundary stops
 * `subtitle="..."` (or any `*title=` attr) from reading as a title.
 */
export const QUOTED_ATTR = /[\w-]+=(?:"[^"]*"|'[^']*')/gu;

/**
 * One fence-meta token: a quoted attribute or a bare word, so a keyword
 * inside a quoted value (`title="enable ts2js later"`) never reads as a
 * bare token.
 */
const META_TOKEN = new RegExp(`${QUOTED_ATTR.source}|\\S+`, "gu");

/** Split a raw fence meta string into its tokens. */
export const metaTokens = (meta: string | null | undefined): string[] =>
  meta?.match(META_TOKEN) ?? [];

/**
 * Bare keywords with reserved meaning after the language; never promoted to
 * a block title.
 */
export const RESERVED_META_KEYWORDS: ReadonlySet<string> = new Set([
  "lineNumbers",
  "ts2js",
  "twoslash",
]);

/** A Shiki `{1,3-5}` line-range token. */
export const isLineRange = (token: string): boolean => token.startsWith("{");
