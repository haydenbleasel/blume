/**
 * Code-fence titles. Authors write a title as the first bare token after the
 * language (```ts blume.config.ts) or as `title="..."`. A Shiki transformer
 * promotes it to a `data-title` attribute on the rendered `<pre>`; the theme's
 * code-block header shows `data-title` when present, falling back to the
 * language label.
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

const TITLE_ATTR = /title=(?<quote>["'])(?<title>[^"']*)\k<quote>/u;

const parseTitle = (raw: string | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }
  const explicit = raw.match(TITLE_ATTR);
  if (explicit?.groups?.title) {
    return explicit.groups.title;
  }
  // Treat the first bare token as the title (```ts blume.config.ts), but skip
  // Shiki line-range meta such as `{1,3-5}`.
  const [first] = raw.trim().split(/\s+/u);
  return first && !first.startsWith("{") ? first : undefined;
};

/** Build the transformer. Runs after Shiki's built-in `data-language` hook. */
export const codeTitleTransformer = (): CodeTitleTransformer => ({
  name: "blume:code-title",
  pre(node) {
    const title = parseTitle(this.options.meta?.__raw);
    if (title) {
      node.properties.dataTitle = title;
    }
  },
});
