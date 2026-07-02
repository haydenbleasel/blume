import { dirname, relative, resolve } from "pathe";

// A relative specifier (starting with `.`) in an `import … from "…"` or
// `export … from "…"` statement. Anchored to the start of a line (`m` flag) and
// bounded by `[^;]` so it only matches a real statement — not a `from "./…"`
// that happens to appear inside a string or JSX text — while still allowing a
// multiline import body between the keyword and `from`.
const FROM_IMPORT =
  /(?<prefix>^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*)(?<quote>["'])(?<spec>\.[^"']*)\k<quote>/gmu;

// A side-effect `import "./…"` at the start of a line.
const SIDE_EFFECT_IMPORT =
  /(?<prefix>^[ \t]*import[ \t]+)(?<quote>["'])(?<spec>\.[^"']*)\k<quote>/gmu;

/**
 * Rewrite a built-in component's relative imports to `blume/*` package
 * specifiers, so a copy installed by `blume add` resolves the rest of the
 * framework from the package instead of broken relative paths.
 *
 * `sourceFile` is the original file's absolute path and `srcRoot` the package
 * `src` directory; a relative import is resolved against the source, mapped to
 * its path under `src`, and re-emitted as `blume/<that path>`. Two specifiers
 * are left untouched: a self-reference (a component importing itself, e.g. the
 * recursive nav tree) stays relative so the copy recurses into the copy, and
 * anything resolving outside `src` is left as-is.
 */
export const rewriteImports = (
  content: string,
  sourceFile: string,
  srcRoot: string
): string => {
  const rewrite = (
    match: string,
    prefix: string,
    quote: string,
    spec: string
  ): string => {
    const resolved = resolve(dirname(sourceFile), spec);
    if (resolved === sourceFile) {
      return match;
    }
    const rel = relative(srcRoot, resolved);
    if (rel.startsWith("..")) {
      return match;
    }
    return `${prefix}${quote}blume/${rel}${quote}`;
  };
  return content
    .replaceAll(FROM_IMPORT, rewrite)
    .replaceAll(SIDE_EFFECT_IMPORT, rewrite);
};
