/** Frontmatter defense in depth: only a real string can carry a handle. */
const isString = <Value>(value: Value): value is Value & string =>
  typeof value === "string";

/**
 * Normalize an X account to the leading `@` that `twitter:site`/`twitter:creator`
 * require, so `acme`, `@acme`, and `  @acme ` all land on `@acme`. Empty or
 * blank input yields undefined, which renders no tag at all.
 *
 * The layouts call this on values that never passed through the config schema:
 * Astro's collections carry no schema here, so a page's `seo.x.creator` reaches
 * them as raw frontmatter, and the schema's own transform never runs on it.
 * (Blume's page pipeline does reject a non-string `creator` before the page is
 * built, so the string guard is defense in depth rather than the expected
 * path.)
 */
export const normalizeXHandle = <Value>(value: Value): string | undefined => {
  if (!isString(value)) {
    return;
  }
  const handle = value.trim().replace(/^@+/u, "");
  return handle ? `@${handle}` : undefined;
};
