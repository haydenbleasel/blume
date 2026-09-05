import { dirname, isAbsolute, relative, resolve } from "pathe";

/**
 * A Tailwind `@source "…"` / `@source not "…"` directive with a quoted path.
 * `@source inline("…")` never matches: the quote must directly follow the
 * keyword (or `not`), and `inline(` sits in between.
 */
const SOURCE_DIRECTIVE =
  /@source(?<not>\s+not)?\s+(?<quote>["'])(?<path>[^"']+)\k<quote>/gu;

/**
 * Rewrite the relative `@source` paths in a user stylesheet so they still
 * point where the author meant once the sheet is inlined into a generated
 * Tailwind entry. Tailwind resolves `@source` relative to the stylesheet that
 * declares it, and Blume splices `theme.css` / `examples.css` verbatim into
 * `.blume/src/generated/*.css` (or `src/generated/*.css` after eject), which
 * would silently re-root them there. Resolving each path against the user's
 * file and re-expressing it relative to the generated directory keeps the
 * standard contract — write `@source "../../packages/ui"` next to the file
 * that says it — and lets a monorepo scan sibling workspace packages for
 * utility classes without any knowledge of Blume's internal layout. Absolute
 * paths pass through untouched.
 */
export const rebaseSourceDirectives = (
  css: string,
  options: {
    /** The user's stylesheet the CSS was read from. */
    from: string;
    /** The directory of the generated entry the CSS is inlined into. */
    to: string;
  }
): string => {
  const base = dirname(options.from);
  return css.replace(
    SOURCE_DIRECTIVE,
    (
      directive: string,
      not: string | undefined,
      quote: string,
      path: string
    ): string => {
      if (isAbsolute(path)) {
        return directive;
      }
      const rebased = relative(options.to, resolve(base, path));
      return `@source${not ?? ""} ${quote}${rebased}${quote}`;
    }
  );
};
