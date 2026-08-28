/**
 * Trailing heading markers, matching Fumadocs' syntax so migrated content works
 * verbatim: `## Heading [#custom-id]` pins the anchor id, `## Heading [!toc]`
 * keeps the heading on the page but out of the table of contents, and
 * `## Heading [toc]` shows it only in the table of contents. Markers chain in
 * any order (`## Heading [toc] [#id]`). The `{#id}` pin of Pandoc, kramdown,
 * and Markdown-based specification toolchains is accepted as an equivalent of
 * `[#id]` — in `.md` verbatim, in `.mdx` only as the escape `\{#id\}` (a bare
 * `{…}` there is a JSX expression; the scan-time scanner reports one as
 * `BLUME_MDX_CURLY_ANCHOR`). Both pipelines resolve escapes before parsing
 * markers, so the escaped and bare spellings reach this parser identically.
 *
 * Both heading pipelines share this parser — the render-time hast plugin
 * (`markdown/heading-anchors.ts`) and the scan-time source scanner
 * (`core/sources/normalize.ts`) — so the rendered `id`, the TOC entry, and the
 * anchor index `blume validate` checks against always agree.
 */

import type GithubSlugger from "github-slugger";

/**
 * Frontmatter key carrying the slugs of `[!toc]` headings out of a render. The
 * hast plugin pushes onto it and the generated page template reads it back via
 * `remarkPluginFrontmatter` to filter the TOC.
 */
export const TOC_HIDDEN_KEY = "__blumeTocHidden";

/**
 * Register a pinned `[#id]` with the document slugger, the way
 * `GithubSlugger#slug` registers the slugs it returns — so a later heading
 * whose auto-slug collides disambiguates (`setup` → `setup-1`) instead of
 * silently duplicating the anchor id. An id that is already taken is left
 * untouched (the pin still uses it verbatim; duplicate pins are the author's
 * explicit choice).
 */
export const occupySlug = (slugger: GithubSlugger, id: string): void => {
  slugger.occurrences[id] ??= 0;
};

/** One trailing marker: `[#id]`, `{#id}`, `[toc]`, or `[!toc]`. */
const MARKER =
  /\s*(?:\{#(?<curlyId>[^\s}]+)\}|\[(?:#(?<id>[^\s\]]+)|(?<hide>!)?toc)\])\s*$/u;

export interface HeadingMarkers {
  /** Author-pinned anchor id from `[#id]` or `{#id}`, used verbatim (never re-slugged). */
  id?: string;
  /** The heading text with every trailing marker stripped. */
  text: string;
  /** `[!toc]` hides the heading from the TOC; `[toc]` shows it only there. */
  toc?: "hide" | "only";
}

/**
 * Split trailing markers off a heading's text. Only markers at the very end of
 * the heading count (mid-text brackets are ordinary prose); when a marker kind
 * repeats, the last one written wins.
 *
 * `isRefDefined` reports whether a link-reference definition exists for a
 * bracket's label (`toc`, `!toc`, `#id`): a defined bracket is a CommonMark
 * shortcut link, not a marker — the renderer sees a resolved `<a>` element
 * there and strips nothing at or before it, so the parse stops the same way.
 * The render-time hast plugin never passes it (resolved links are already
 * elements by the time it runs); the raw-source scanner does.
 */
export const parseHeadingMarkers = (
  text: string,
  isRefDefined?: (label: string) => boolean
): HeadingMarkers => {
  let remaining = text;
  let id: string | undefined;
  let toc: HeadingMarkers["toc"];
  for (
    let match = MARKER.exec(remaining);
    match?.groups;
    match = MARKER.exec(remaining)
  ) {
    const explicitId = match.groups.curlyId ?? match.groups.id;
    const label =
      explicitId === undefined
        ? `${match.groups.hide ?? ""}toc`
        : `#${explicitId}`;
    // A `{#id}` is never a shortcut link, whatever the definitions say.
    if (match.groups.curlyId === undefined && isRefDefined?.(label)) {
      break;
    }
    remaining = remaining.slice(0, match.index);
    if (explicitId === undefined) {
      // Stripping runs right-to-left, so keeping the first capture of each
      // kind makes the rightmost occurrence win.
      toc ??= match.groups.hide === undefined ? "only" : "hide";
    } else {
      id ??= explicitId;
    }
  }
  return { id, text: remaining, toc };
};
