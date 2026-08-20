import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  basename,
  dirname,
  extname,
  normalize,
  relative,
  resolve,
} from "pathe";

import { normalizeBasePath } from "./base-path.ts";
import { hashText } from "./sources/cache.ts";
import type { FenceState } from "./sources/normalize.ts";
import {
  INLINE_CODE,
  MD_IMAGE,
  nextFenceState,
  targetOffsetIn,
} from "./sources/normalize.ts";

/**
 * Colocated content images — `![alt](./diagram.png)` next to the page that
 * references it. The HTML render optimizes these through `astro:assets` into
 * hashed `_astro/` files, but that mapping doesn't exist yet when the raw
 * agent-facing Markdown (`/<route>.md`, llms-full.txt, MCP) is snapshotted at
 * generate time — so a verbatim relative path would 404 for every agent
 * fetching the page by URL. Instead, the originals are served at
 * `/blume-assets/content/<project-relative path>` by a generated endpoint (see
 * `contentAssetsEndpointTemplate`), and these helpers rewrite the relative
 * references in agent-facing output to that URL.
 */

/** The endpoint route prefix colocated content images are served under. */
export const CONTENT_ASSETS_PREFIX = "/blume-assets/content";

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

/** Whether a link target is a relative filesystem path (not URL/absolute/hash). */
const isRelativeTarget = (target: string): boolean =>
  !(target.startsWith("/") || target.startsWith("#")) && !URL.canParse(target);

/**
 * The endpoint param a colocated image is served under: its project-relative
 * path (readable, collision-free — it mirrors the source tree). A file outside
 * the project root can't be addressed that way (`..` segments don't survive a
 * URL), so it falls back to a content-addressed name.
 */
export const contentAssetParam = (
  projectRoot: string,
  absPath: string
): string => {
  const rel = relative(projectRoot, absPath);
  if (rel.startsWith("..")) {
    return `_/${hashText(absPath)}${extname(absPath)}`;
  }
  return rel;
};

/** Percent-decode an image target; malformed escapes stay verbatim. */
const decodeTarget = (target: string): string => {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
};

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
 * Resolve one image target against its page's directory. Returns the absolute
 * file path when the target is relative, is an image, and exists on disk —
 * anything else (remote URLs, `public/` absolutes, broken refs, code-block
 * examples that happen to look like paths) is null and left untouched. Shared
 * with link validation, so what counts as a colocated image is decided once.
 */
export const resolveRelativeImage = (
  sourceDir: string,
  target: string
): string | null => {
  if (!isRelativeImageTarget(target)) {
    return null;
  }
  const decoded = decodeTarget(target);
  // Only the segments the author wrote are checked against on-disk names;
  // `sourceDir`'s own casing is the filesystem's business, not the target's.
  const segments = normalize(decoded)
    .split("/")
    .filter((part) => part !== "" && part !== "..").length;
  const abs = resolve(sourceDir, decoded);
  return existsAsWritten(abs, segments) ? abs : null;
};

/** Encode an endpoint param for use in a Markdown URL, keeping `/` separators. */
const encodedParam = (param: string): string =>
  param.split("/").map(encodeURIComponent).join("/");

/**
 * Rewrite one line's relative image targets. Matches run on a copy with inline
 * code blanked out (a `` `![x](./y.png)` `` span is syntax being *shown*, not
 * an image), while replacements splice into the real line by index — the mask
 * preserves length, so the indices line up.
 */
const rewriteLine = (
  line: string,
  toUrl: (target: string) => string | null
): string => {
  const masked = line.replaceAll(INLINE_CODE, (span) =>
    " ".repeat(span.length)
  );
  let out = "";
  let cursor = 0;
  for (const match of masked.matchAll(MD_IMAGE)) {
    const target = match.groups?.target ?? "";
    const url = toUrl(target);
    if (url === null) {
      continue;
    }
    const offset =
      (match.index ?? 0) +
      targetOffsetIn(match[0], target, match.groups?.title);
    out += line.slice(cursor, offset) + url;
    cursor = offset + target.length;
  }
  return out + line.slice(cursor);
};

/**
 * Rewrite a page's relative image references to their served
 * `/blume-assets/content/…` URLs (under `deployment.base` when set). Fenced
 * code blocks and inline code are skipped; only references whose file actually
 * exists next to the source are touched. `register` observes each rewritten
 * asset so a caller can accumulate the files the endpoint must serve.
 */
export const rewriteRelativeImages = (options: {
  source: string;
  sourcePath: string;
  projectRoot: string;
  deployBase?: string;
  register?: (param: string, absPath: string) => void;
}): string => {
  const { source, sourcePath, projectRoot, deployBase, register } = options;
  const sourceDir = dirname(sourcePath);
  const prefix = `${normalizeBasePath(deployBase)}${CONTENT_ASSETS_PREFIX}`;
  const toUrl = (target: string): string | null => {
    const abs = resolveRelativeImage(sourceDir, target);
    if (abs === null) {
      return null;
    }
    const param = contentAssetParam(projectRoot, abs);
    register?.(param, abs);
    return `${prefix}/${encodedParam(param)}`;
  };

  let fence: FenceState = null;
  const lines = source.split("\n").map((line) => {
    const next = nextFenceState(line, fence);
    const inFence = fence !== null || next !== null;
    fence = next;
    return inFence ? line : rewriteLine(line, toUrl);
  });
  return lines.join("\n");
};

/**
 * Every colocated image the project's pages reference, keyed by endpoint param.
 * Serialized to `generated/content-assets.json`, which the
 * `/blume-assets/[...asset]` endpoint reads to serve the original files. Runs
 * the same rewrite the agent-Markdown builders apply, so the served set and the
 * rewritten URLs can't drift apart.
 */
export const collectContentAssets = async (project: {
  context: { root: string };
  manifest: { routes: { sourcePath?: string }[] };
}): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  await Promise.all(
    project.manifest.routes.map(async (route) => {
      if (!route.sourcePath) {
        return;
      }
      let source: string;
      try {
        source = await readFile(route.sourcePath, "utf-8");
      } catch {
        return;
      }
      rewriteRelativeImages({
        projectRoot: project.context.root,
        register: (param, abs) => {
          files[param] = abs;
        },
        source,
        sourcePath: route.sourcePath,
      });
    })
  );
  return files;
};
