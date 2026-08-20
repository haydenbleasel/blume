import { mkdir, writeFile } from "node:fs/promises";

import { extname, join } from "pathe";

import type { Diagnostic } from "../types.ts";
import { hashText } from "./cache.ts";

const MD_IMAGE = /!\[(?<alt>[^\]]*)\]\((?<url>[^)\s]+)\)/gu;
const REMOTE = /^https?:\/\//u;
const SAFE_EXT = /^\.[a-z0-9]+$/iu;
const CODE_FENCE_BLOCK =
  /^(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?^\k<fence>[^\n]*(?=\n|$)/gmu;
// NUL delimiters cannot appear in authored markdown, so tokens never collide.
// oxlint-disable-next-line no-control-regex -- the NUL is the collision guard.
const FENCE_TOKEN = /\u0000blume-fence-(?<index>\d+)\u0000/gu;

/** Where to write downloaded assets and how to reference them publicly. */
export interface AssetContext {
  assetsDir: string;
  assetsBaseUrl: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Pick a file extension from a URL, defaulting to `.png`. */
const extFor = (url: string): string => {
  const clean = url.split("?")[0] ?? url;
  const ext = extname(clean);
  return SAFE_EXT.test(ext) ? ext.toLowerCase() : ".png";
};

/**
 * Download remote images referenced in a Markdown body into the asset dir and
 * rewrite their `src` to the local public path. Remote CMS URLs (notably
 * Notion's signed, expiring links) would otherwise rot a static build. Assets
 * are content-addressed by URL hash, so repeated builds are stable and deduped.
 */
export const materializeAssets = async (
  markdown: string,
  ctx: AssetContext
): Promise<{ markdown: string; diagnostics: Diagnostic[] }> => {
  const doFetch = ctx.fetchImpl ?? globalThis.fetch;
  const diagnostics: Diagnostic[] = [];

  // Mask fenced code blocks so an image URL inside a code sample is neither
  // downloaded nor rewritten — the sample must keep showing what the author
  // wrote.
  const fences: string[] = [];
  const masked = markdown.replace(CODE_FENCE_BLOCK, (block) => {
    fences.push(block);
    return `\u0000blume-fence-${fences.length - 1}\u0000`;
  });

  const urls = new Set<string>();
  for (const match of masked.matchAll(MD_IMAGE)) {
    const url = match.groups?.url;
    if (url && REMOTE.test(url)) {
      urls.add(url);
    }
  }

  const rewrites = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const res = await doFetch(url);
        if (!res.ok) {
          throw new Error(`${res.status}`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        // Hash the query-less URL (as `extFor` does): CMS asset URLs are
        // pre-signed, so the query changes on every fetch of the same image —
        // hashing it would mint a new file each refresh and re-dirty the
        // content digest. Two real assets sharing scheme+host+path and
        // differing only in query are rare enough to accept colliding.
        const file = `${hashText(url.split("?")[0] ?? url)}${extFor(url)}`;
        await mkdir(ctx.assetsDir, { recursive: true });
        await writeFile(join(ctx.assetsDir, file), bytes);
        rewrites.set(url, `${ctx.assetsBaseUrl}/${file}`);
      } catch (error) {
        // SAFETY: everything thrown in this block is an Error — the manual
        // `!res.ok` throw above, and fetch/fs failures.
        diagnostics.push({
          code: "BLUME_ASSET_FETCH_FAILED",
          message: `Failed to download asset ${url}: ${(error as Error).message}`,
          severity: "warning",
        });
      }
    })
  );

  const rewritten = masked
    .replaceAll(MD_IMAGE, (match, alt, url) => {
      const local = rewrites.get(url);
      return local ? `![${alt}](${local})` : match;
    })
    .replaceAll(FENCE_TOKEN, (token, index) => fences[Number(index)] ?? token);

  return { diagnostics, markdown: rewritten };
};
