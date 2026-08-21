/**
 * Code-fence meta. A Shiki transformer reads the tokens after the language and
 * promotes them to attributes on the rendered `<pre>`:
 *
 * - a title — the first bare token (```ts blume.config.ts) or `title="..."` —
 *   becomes `data-title`; the theme's code header shows it, falling back to the
 *   language label.
 * - the `lineNumbers` keyword (```ts file.ts lineNumbers) becomes
 *   `data-line-numbers`; the theme renders a counter-driven line-number gutter.
 */

import {
  isLineRange,
  QUOTED_ATTR,
  RESERVED_META_KEYWORDS,
} from "./fence-meta.ts";

/** The slice of Shiki's transformer `this` context Blume reads. */
interface CodeMetaContext {
  options: { meta?: { __raw?: string } };
}

/** The `<pre>` hast node a Shiki `pre` hook receives. */
interface PreNode {
  properties: Record<string, boolean | number | string | undefined>;
}

/** A Shiki-compatible transformer, typed structurally to avoid a Shiki dep. */
export interface CodeTitleTransformer {
  name: string;
  pre: (this: CodeMetaContext, node: PreNode) => void;
}

const TITLE_ATTR = /(?:^|\s)title=(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')/u;
const LINE_NUMBERS = /(?:^|\s)lineNumbers(?=\s|$)/u;

// Quoted attrs are blanked before keyword/bare-token scans so a quoted value
// can't leak tokens (`title="enable lineNumbers later"`).
const withoutQuotedAttrs = (raw: string): string =>
  raw.replace(QUOTED_ATTR, " ");

// The first bare token is the title (```ts blume.config.ts): a non-empty token
// that isn't a Shiki line range (`{1,3-5}`), a `key=value` attr, or a reserved
// keyword.
const isTitleToken = (token: string): boolean =>
  token.length > 0 &&
  !isLineRange(token) &&
  !token.includes("=") &&
  !RESERVED_META_KEYWORDS.has(token);

const parseTitle = (raw: string | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }
  // Blank every *other* quoted attr first, so a `title="…"` embedded in
  // another attribute's value (`caption='set title="X" here'`) can't be
  // promoted to the block title.
  const scrubbed = raw.replace(QUOTED_ATTR, (attr) =>
    attr.startsWith("title=") ? attr : " "
  );
  const explicit = scrubbed.match(TITLE_ATTR);
  const attrTitle = explicit?.groups?.dq ?? explicit?.groups?.sq;
  if (attrTitle) {
    return attrTitle;
  }
  return withoutQuotedAttrs(raw).trim().split(/\s+/u).find(isTitleToken);
};

const hasLineNumbers = (raw: string | undefined): boolean =>
  Boolean(raw && LINE_NUMBERS.test(withoutQuotedAttrs(raw)));

/** Build the transformer. Runs after Shiki's built-in `data-language` hook. */
export const codeTitleTransformer = (): CodeTitleTransformer => ({
  name: "blume:code-meta",
  pre(node) {
    const raw = this.options.meta?.__raw;
    const title = parseTitle(raw);
    if (title) {
      node.properties.dataTitle = title;
    }
    if (hasLineNumbers(raw)) {
      node.properties.dataLineNumbers = true;
    }
  },
});
