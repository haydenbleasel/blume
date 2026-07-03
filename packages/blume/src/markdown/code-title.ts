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

// The body excludes only the delimiting quote, so `title="foo's file.ts"`
// (an apostrophe inside double quotes) still matches.
const TITLE_ATTR = /title=(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')/u;
const LINE_NUMBERS = /(?:^|\s)lineNumbers(?=\s|$)/u;

const parseTitle = (raw: string | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }
  const explicit = raw.match(TITLE_ATTR);
  const attrTitle = explicit?.groups?.dq ?? explicit?.groups?.sq;
  if (attrTitle) {
    return attrTitle;
  }
  // The first bare token is the title (```ts blume.config.ts), skipping Shiki
  // line ranges (`{1,3-5}`), `key=value` attrs, and the reserved `lineNumbers`
  // and `twoslash` keywords.
  return raw
    .trim()
    .split(/\s+/u)
    .find(
      (token) =>
        token.length > 0 &&
        token !== "lineNumbers" &&
        token !== "twoslash" &&
        !token.startsWith("{") &&
        !token.includes("=")
    );
};

const hasLineNumbers = (raw: string | undefined): boolean =>
  Boolean(raw && LINE_NUMBERS.test(raw));

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
