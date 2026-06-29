import { mkdir, writeFile } from "node:fs/promises";

import { extname, join } from "pathe";

import type { Diagnostic } from "../types.ts";
import { hashText } from "./cache.ts";

const MD_IMAGE = /!\[(?<alt>[^\]]*)\]\((?<url>[^)\s]+)\)/gu;
const REMOTE = /^https?:\/\//u;
const SAFE_EXT = /^\.[a-z0-9]+$/iu;

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

  const urls = new Set<string>();
  for (const match of markdown.matchAll(MD_IMAGE)) {
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
        const file = `${hashText(url)}${extFor(url)}`;
        await mkdir(ctx.assetsDir, { recursive: true });
        await writeFile(join(ctx.assetsDir, file), bytes);
        rewrites.set(url, `${ctx.assetsBaseUrl}/${file}`);
      } catch (error) {
        diagnostics.push({
          code: "BLUME_ASSET_FETCH_FAILED",
          message: `Failed to download asset ${url}: ${(error as Error).message}`,
          severity: "warning",
        });
      }
    })
  );

  const rewritten = markdown.replaceAll(MD_IMAGE, (match, alt, url) => {
    const local = rewrites.get(url);
    return local ? `![${alt}](${local})` : match;
  });

  return { diagnostics, markdown: rewritten };
};
