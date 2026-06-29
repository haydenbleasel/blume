import { dirname, relative, resolve } from "pathe";

// The module specifier in `... from "<spec>"` and side-effect `import "<spec>"`,
// limited to relative specifiers (those starting with `.`). Capturing the
// keyword, gap, and quote lets us rebuild the statement verbatim.
const RELATIVE_IMPORT =
  /(?<kw>\bfrom|\bimport)(?<gap>\s+)(?<quote>["'])(?<spec>\.[^"']*)\k<quote>/gu;

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
): string =>
  content.replaceAll(
    RELATIVE_IMPORT,
    (match, kw: string, gap: string, quote: string, spec: string) => {
      const resolved = resolve(dirname(sourceFile), spec);
      if (resolved === sourceFile) {
        return match;
      }
      const rel = relative(srcRoot, resolved);
      if (rel.startsWith("..")) {
        return match;
      }
      return `${kw}${gap}${quote}blume/${rel}${quote}`;
    }
  );
