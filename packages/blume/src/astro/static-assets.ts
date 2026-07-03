import { createReadStream, existsSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { cp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { extname, join, relative, resolve, sep } from "pathe";

import type { AssetMount } from "../core/assets.ts";

/** Content types for the asset extensions a docs project commonly serves. */
const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const mimeType = (file: string): string =>
  MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

/** Whether `child` is `parent` itself or a path nested under it. */
const isContained = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
};

/** Resolve a request URL to an on-disk file within one of the mounts, if any. */
const resolveRequest = (url: string, mounts: AssetMount[]): string | null => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(
      (url.split("?")[0] ?? "").split("#")[0] ?? ""
    );
  } catch {
    // Malformed percent-encoding (`/images/%zz`) throws URIError; treat it as
    // a plain miss (404) rather than a middleware exception.
    return null;
  }
  for (const mount of mounts) {
    if (pathname !== mount.url && !pathname.startsWith(`${mount.url}/`)) {
      continue;
    }
    // `.` + rel keeps the join relative so an absolute-looking suffix can't
    // escape the mount; the containment check rejects `..` traversal outright.
    const file = resolve(mount.dir, `.${pathname.slice(mount.url.length)}`);
    if (isContained(mount.dir, file)) {
      return file;
    }
  }
  return null;
};

/** `statSync` that returns null instead of throwing on a missing file. */
const statFile = (file: string): Stats | null => {
  try {
    return statSync(file);
  } catch {
    return null;
  }
};

/**
 * A dev-server middleware that serves `content.assets` mounts (top-level dirs
 * kept in place, e.g. a migrated `images/`) at their site URL. Astro only serves
 * `publicDir` in dev, so without this those references would 404. Non-matching
 * requests, and any path that isn't a real file, fall through to Astro. Stat is
 * synchronous — this is dev-only middleware and mirrors how sirv serves statics.
 */
export const serveAssetMounts =
  (mounts: AssetMount[]) =>
  (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if ((req.method !== "GET" && req.method !== "HEAD") || !req.url) {
      next();
      return;
    }
    const file = resolveRequest(req.url, mounts);
    const stats = file ? statFile(file) : null;
    if (!(file && stats?.isFile())) {
      next();
      return;
    }
    res.setHeader("Content-Type", mimeType(file));
    res.setHeader("Content-Length", String(stats.size));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };

/**
 * Copy every asset mount into the build output, mirroring what Astro does with
 * `publicDir`. Runs on `astro:build:done` so in-place asset dirs ship in the
 * final `dist/`. A missing source dir is skipped (it may be referenced but
 * absent); `cp` handles both directories and single files.
 */
export const copyAssetMounts = async (
  mounts: AssetMount[],
  outDir: string
): Promise<void> => {
  for (const mount of mounts) {
    if (!existsSync(mount.dir)) {
      continue;
    }
    const dest = join(outDir, mount.url.replace(/^\/+/u, ""));
    // oxlint-disable-next-line no-await-in-loop -- sequential fs copies
    await cp(mount.dir, dest, { recursive: true });
  }
};
