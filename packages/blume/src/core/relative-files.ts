import { readdirSync, statSync } from "node:fs";

import { basename, dirname, extname, normalize, resolve } from "pathe";

/**
 * The files a page names beside it: an image it embeds (`![](./diagram.png)`)
 * and any other file it links (`[spec](./spec.pdf)`, `<img src>`). One
 * reading, shared by everything that handles them: the include expander that
 * rebases a partial's, the content-asset rewriter that publishes them, the
 * render plugin that points the built page at them, and link validation.
 */

// The formats Astro's image pipeline accepts, plus the web-safe pass-throughs;
// anything else referenced relatively (a `.pdf`, a source file) is left alone.
const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
]);

// A link to one of these names a page (see `resolveRelativeHref` in
// `links.ts`), never a file to publish.
const PAGE_EXTENSIONS = new Set([".md", ".mdx"]);

/** Whether a link target is a relative filesystem path (not URL/absolute/hash). */
const isRelativeTarget = (target: string): boolean =>
  !(target.startsWith("/") || target.startsWith("#")) && !URL.canParse(target);

/** Percent-decode a target; malformed escapes stay verbatim. */
const decodeTarget = (target: string): string => {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
};

/** The path a target names, decoded, its query and hash aside. */
export const targetPath = (target: string): string =>
  decodeTarget(target.split(/[?#]/u)[0] ?? "");

/** Whether `target` names a file with an image extension, query and hash aside. */
export const hasImageExtension = (target: string): boolean =>
  IMAGE_EXTENSIONS.has(extname(targetPath(target)).toLowerCase());

/**
 * Whether a target is *shaped* like a colocated image reference: a relative
 * filesystem path with an image extension. Exported so link validation can
 * tell "not a colocated candidate" apart from "a candidate that resolves
 * nowhere" — the former falls through to the public-dir probe, the latter is
 * a broken reference beside the page source.
 */
export const isRelativeImageTarget = (target: string): boolean =>
  isRelativeTarget(target) &&
  IMAGE_EXTENSIONS.has(extname(decodeTarget(target)).toLowerCase());

/**
 * Whether `abs` is a file whose trailing `segments` names match the on-disk
 * entries exactly. A bare `existsSync` accepts `./Diagram.PNG` for
 * `diagram.png` (or a directory named like an image) on a case-insensitive
 * filesystem — the reference then validates and serves locally but breaks on
 * the case-sensitive Linux build.
 */
const existsAsWritten = (abs: string, segments: number): boolean => {
  let current = abs;
  for (let i = 0; i < segments; i += 1) {
    const parent = dirname(current);
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      return false;
    }
    if (!entries.includes(basename(current))) {
      return false;
    }
    current = parent;
  }
  const stat = statSync(abs, { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
};

/**
 * The file a decoded relative `path` names from `sourceDir`, when it's on
 * disk as written. Only the segments the author wrote are checked against
 * on-disk names; `sourceDir`'s own casing is the filesystem's business, not
 * the target's.
 */
const fileAsWritten = (sourceDir: string, path: string): string | null => {
  const segments = normalize(path)
    .split("/")
    .filter((part) => part !== "" && part !== "..").length;
  const abs = resolve(sourceDir, path);
  return existsAsWritten(abs, segments) ? abs : null;
};

/**
 * Resolve one image target against its page's directory. Returns the absolute
 * file path when the target is relative, is an image, and exists on disk —
 * anything else (remote URLs, `public/` absolutes, broken refs, code-block
 * examples that happen to look like paths) is null and left untouched. Shared
 * with link validation, so what counts as a colocated image is decided once.
 */
export const resolveRelativeImage = (
  sourceDir: string,
  target: string
): string | null =>
  isRelativeImageTarget(target)
    ? fileAsWritten(sourceDir, decodeTarget(target))
    : null;

/** A file a link names beside its page, and the link's `?query#fragment`. */
export interface RelativeFile {
  path: string;
  suffix: string;
}

/**
 * Resolve the file a link, an element's `src`, or an `href` names beside its
 * page (`./spec.pdf`, `../files/data.csv#L2`): a relative path whose name
 * carries an extension other than a page's (`.md`, `.mdx`), on disk as
 * written (see `existsAsWritten`). Its `?query` or `#fragment` is set aside,
 * so `./spec.pdf#page=2` opens the served file at that page. Anything else is
 * null: a page link, a URL, a root path, a missing file. Shared with link
 * validation, which accepts what this resolves.
 */
export const resolveRelativeFile = (
  sourceDir: string,
  target: string
): RelativeFile | null => {
  const at = target.search(/[?#]/u);
  const path = decodeTarget(at === -1 ? target : target.slice(0, at));
  const extension = extname(path).toLowerCase();
  if (
    !isRelativeTarget(target) ||
    extension === "" ||
    PAGE_EXTENSIONS.has(extension)
  ) {
    return null;
  }
  const file = fileAsWritten(sourceDir, path);
  return file === null
    ? null
    : { path: file, suffix: at === -1 ? "" : target.slice(at) };
};
