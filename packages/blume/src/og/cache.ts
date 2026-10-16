import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import { dirname, join } from "pathe";

import type { ProjectContext } from "../core/types.ts";
import type { OgCardOptions, OgFont } from "./card.ts";

/**
 * Where a build keeps rendered OG cards between runs (see {@link cardCacheKey}
 * for what invalidates one). Baked into the generated OG endpoint alongside
 * the Blume version that renders the cards.
 */
export interface OgCache {
  /** Absolute directory holding `<key>.png` files. */
  dir: string;
  /** The Blume version rendering the cards; part of every key. */
  version: string;
}

/**
 * The card cache directory for a project: `node_modules/.cache/blume/og`,
 * the conventional build-cache location. Vercel and Netlify restore
 * `node_modules` from their build caches, so a deploy there re-renders only
 * the cards whose inputs changed; Cloudflare Workers Builds keeps only
 * package-manager caches (and `node_modules/.astro` for a detected Astro
 * project), and a self-managed runner needs a cache step for the directory.
 * A project with no `node_modules` of its own falls back to the runtime's
 * cache dir next to Astro's and Vite's.
 */
export const ogCacheDir = (
  context: Pick<ProjectContext, "outDir" | "root">
): string =>
  existsSync(join(context.root, "node_modules"))
    ? join(context.root, "node_modules", ".cache", "blume", "og")
    : join(context.outDir, ".cache", "og");

/**
 * Per-process tally of cache hits and misses plus the keys this build asked
 * for, read back by the CLI after `build()` for the summary line and the
 * prune. On `globalThis` for the same reason as the integration registry: the
 * endpoint renders in the copy of this module Vite bundled for the prerender,
 * while the CLI reads from its own bundled copy.
 */
interface OgCacheRegistry {
  hits: number;
  misses: number;
  used: Set<string>;
}

const REGISTRY_KEY = Symbol.for("blume.og-cache");

type RegistryHost = typeof globalThis & { [REGISTRY_KEY]?: OgCacheRegistry };

const registry = (): OgCacheRegistry => {
  // SAFETY: the registry is stashed on globalThis under a well-known symbol so
  // every copy of this module in the process shares it; the intersection only
  // names that slot.
  const host = globalThis as RegistryHost;
  host[REGISTRY_KEY] ??= { hits: 0, misses: 0, used: new Set() };
  return host[REGISTRY_KEY];
};

/** Type guard: is this OG font a local file entry? */
export const isLocalOgFont = (
  font: OgFont
): font is Extract<OgFont, { src: string }> =>
  typeof font !== "string" && "src" in font;

// A local font file's contents digest, computed once per path per process: the
// key must follow the file's bytes, not its mtime (a fresh CI checkout resets
// every mtime, which would miss the whole cache on each build).
const localFontDigests = new Map<string, Promise<string>>();

const digestFile = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const localFontDigest = (path: string): Promise<string> => {
  let digest = localFontDigests.get(path);
  if (!digest) {
    digest = digestFile(path);
    localFontDigests.set(path, digest);
  }
  return digest;
};

/**
 * A blog post's local cover by its contents, like a local font: renaming
 * nothing but redrawing the image must still re-render the card. A file that
 * can't be read keys as missing (the card renders without it).
 */
const coverDigest = async (cover: string | undefined) => {
  if (!cover || /^(?:https?:\/\/|data:)/iu.test(cover)) {
    return;
  }
  try {
    return await digestFile(cover);
  } catch {
    return "missing";
  }
};

/**
 * The cache key of a card: a digest of everything that decides its pixels —
 * the card options (title, description, brand, logo markup, palette, footer
 * text, font families, a blog post's byline), the fonts (a local file by its
 * contents, a Google family by its request), a local cover by its contents,
 * and the Blume version, since the layout and the renderer it pins ship with
 * the package. Pre-fetched `images` are left out: the endpoint never passes
 * them.
 */
export const cardCacheKey = async (
  version: string,
  options: OgCardOptions
): Promise<string> => {
  const fonts = await Promise.all(
    (options.fonts ?? []).map(async (font) =>
      isLocalOgFont(font)
        ? { ...font, digest: await localFontDigest(font.src) }
        : font
    )
  );
  // A local cover keys by its bytes alone, not its path on this machine, so
  // a fresh checkout elsewhere still hits the cache.
  const digest = await coverDigest(options.article?.cover);
  const article =
    digest && options.article
      ? { ...options.article, cover: digest }
      : options.article;
  const card = { ...options, article, fonts: undefined, images: undefined };
  return createHash("sha256")
    .update(JSON.stringify({ card, fonts, version }))
    .digest("hex");
};

const cardPath = (cache: OgCache, key: string): string =>
  join(cache.dir, `${key}.png`);

/** A cached card's bytes, or `null` when there is none. */
const readCard = async (file: string): Promise<Uint8Array | null> => {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
};

// Written to a sibling temp file and renamed into place: concurrent page
// renders may store the same key, and a reader must never see a half-written
// card.
const storeCard = async (file: string, png: Uint8Array): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, png);
  await rename(tmp, file);
};

/** Cards rendered short of their inputs, which the cache must not keep. */
const partial = new WeakSet<Uint8Array>();

/**
 * Mark a card rendered without some of its inputs (a cover that failed to
 * load): it's served, but not stored, so the next build tries again rather
 * than reading back a card a passing network error left without its cover.
 */
export const withoutStoring = (png: Uint8Array): Uint8Array => {
  partial.add(png);
  return png;
};

/** The in-flight renders of this process, so duplicate titles render once. */
const inflight = new Map<string, Promise<Uint8Array>>();

const renderAndStore = async (
  key: string,
  file: string,
  options: OgCardOptions,
  render: (options: OgCardOptions) => Promise<Uint8Array>
): Promise<Uint8Array> => {
  try {
    const png = await render(options);
    try {
      if (!partial.has(png)) {
        await storeCard(file, png);
      }
    } catch {
      // An unwritable cache (a read-only workspace) never fails the build.
    }
    return png;
  } finally {
    inflight.delete(key);
  }
};

/**
 * Serve a card from `cache`, rendering it with `render` on a miss and storing
 * the result for the next build. Without a cache every card renders; the
 * cache is only ever a shortcut.
 */
export const throughCardCache = async (
  cache: OgCache | undefined,
  options: OgCardOptions,
  render: (options: OgCardOptions) => Promise<Uint8Array>
): Promise<Uint8Array> => {
  if (!cache) {
    return render(options);
  }
  const key = await cardCacheKey(cache.version, options);
  const state = registry();
  state.used.add(key);
  const file = cardPath(cache, key);
  const hit = await readCard(file);
  if (hit) {
    state.hits += 1;
    return hit;
  }
  let pending = inflight.get(key);
  if (!pending) {
    state.misses += 1;
    pending = renderAndStore(key, file, options, render);
    inflight.set(key, pending);
  }
  return pending;
};

/**
 * Remove the cards this build never asked for — a renamed page, a changed
 * description, a previous Blume version — plus any temp file a crashed build
 * left behind, so a persisted cache holds exactly the current site's cards.
 * Returns how many files were removed; a missing directory removes nothing.
 */
export const pruneCardCache = async (dir: string): Promise<number> => {
  const { used } = registry();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const stale = entries.filter(
    (name) =>
      name.endsWith(".tmp") ||
      (name.endsWith(".png") && !used.has(name.slice(0, -".png".length)))
  );
  await Promise.all(stale.map((name) => rm(join(dir, name), { force: true })));
  return stale.length;
};

/**
 * This process's card cache tally — how many cards a build reused and how many
 * it rendered — or `null` when no card was requested (OG cards off, or an
 * endpoint-free build).
 */
export const cardCacheTally = (): { hits: number; misses: number } | null => {
  const { hits, misses } = registry();
  return hits + misses === 0 ? null : { hits, misses };
};

/** Reset the tally and the used-key set (tests). */
export const resetCardCacheTally = (): void => {
  const state = registry();
  state.hits = 0;
  state.misses = 0;
  state.used.clear();
};
