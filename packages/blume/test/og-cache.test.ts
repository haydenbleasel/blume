import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  cardCacheKey,
  cardCacheTally,
  ogCacheDir,
  pruneCardCache,
  resetCardCacheTally,
  throughCardCache,
  withoutStoring,
} from "../src/og/cache.ts";
import type { OgCache } from "../src/og/cache.ts";
import type { OgCardOptions } from "../src/og/card.ts";

const png = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("cardCacheKey", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "blume-og-key-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("is stable for equal inputs and changes with any card input", async () => {
    const base: OgCardOptions = {
      brand: "Blume",
      description: "Docs",
      title: "Guide",
    };
    const key = await cardCacheKey("1.0.0", base);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(await cardCacheKey("1.0.0", { ...base })).toBe(key);
    expect(await cardCacheKey("1.0.0", { ...base, title: "Guide 2" })).not.toBe(
      key
    );
    expect(
      await cardCacheKey("1.0.0", { ...base, palette: { accent: "red" } })
    ).not.toBe(key);
    // The renderer ships with the package: a new Blume is a new key.
    expect(await cardCacheKey("1.0.1", base)).not.toBe(key);
  });

  it("keys a local font by its contents and a Google font by its request", async () => {
    const font = join(dir, "brand.ttf");
    await writeFile(font, "glyphs v1");
    const options: OgCardOptions = {
      fonts: [{ name: "Brand", src: font }, "Noto Sans JP"],
      title: "Guide",
    };
    const first = await cardCacheKey("1.0.0", options);
    // Same bytes, same key — the digest is memoized per path, so overwriting
    // the file within a process keeps the first digest; a second path with
    // different bytes is what changes the key.
    expect(await cardCacheKey("1.0.0", options)).toBe(first);
    const other = join(dir, "brand-2.ttf");
    await writeFile(other, "glyphs v2");
    expect(
      await cardCacheKey("1.0.0", {
        ...options,
        fonts: [{ name: "Brand", src: other }, "Noto Sans JP"],
      })
    ).not.toBe(first);
    expect(
      await cardCacheKey("1.0.0", {
        ...options,
        fonts: [{ name: "Brand", src: font }, "Noto Sans KR"],
      })
    ).not.toBe(first);
  });
});

describe("throughCardCache", () => {
  let cache: OgCache;

  beforeEach(async () => {
    resetCardCacheTally();
    cache = {
      dir: join(await mkdtemp(join(tmpdir(), "blume-og-cache-")), "og"),
      version: "1.0.0",
    };
  });

  afterEach(async () => {
    await rm(cache.dir, { force: true, recursive: true });
  });

  it("renders on a miss, stores the card, and reads it back on the next request", async () => {
    let renders = 0;
    const render = (options: OgCardOptions) => {
      renders += 1;
      return Promise.resolve(png(`card:${options.title}`));
    };
    const first = await throughCardCache(cache, { title: "A" }, render);
    expect(new TextDecoder().decode(first)).toBe("card:A");
    expect(renders).toBe(1);
    const files = await readdir(cache.dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.png$/u);

    const again = await throughCardCache(cache, { title: "A" }, render);
    expect(new TextDecoder().decode(again)).toBe("card:A");
    expect(renders).toBe(1);
    expect(cardCacheTally()).toEqual({ hits: 1, misses: 1 });
  });

  it("serves a card rendered short of its inputs without storing it", async () => {
    let renders = 0;
    const render = () => {
      renders += 1;
      return Promise.resolve(withoutStoring(png("no cover")));
    };
    await throughCardCache(cache, { title: "A" }, render);
    // The next build tries again: a passing error isn't kept.
    await throughCardCache(cache, { title: "A" }, render);
    expect(renders).toBe(2);
  });

  it("renders duplicate titles once while the first render is in flight", async () => {
    let renders = 0;
    const pending = Promise.withResolvers<Uint8Array>();
    const render = () => {
      renders += 1;
      return pending.promise;
    };
    const a = throughCardCache(cache, { title: "Same" }, render);
    const b = throughCardCache(cache, { title: "Same" }, render);
    pending.resolve(png("same"));
    expect(await Promise.all([a, b])).toEqual([png("same"), png("same")]);
    expect(renders).toBe(1);
    expect(cardCacheTally()).toEqual({ hits: 0, misses: 1 });
  });

  it("renders every card and tallies nothing without a cache", async () => {
    let renders = 0;
    const render = () => {
      renders += 1;
      return Promise.resolve(png("x"));
    };
    await throughCardCache(undefined, { title: "A" }, render);
    await throughCardCache(undefined, { title: "A" }, render);
    expect(renders).toBe(2);
    expect(cardCacheTally()).toBeNull();
  });

  it("still returns the card when the cache directory cannot be written", async () => {
    // A regular file where the directory should be: mkdir fails.
    const blocked = join(cache.dir, "..", "blocked");
    await writeFile(blocked, "");
    const result = await throughCardCache(
      { dir: blocked, version: "1.0.0" },
      { title: "A" },
      () => Promise.resolve(png("rendered"))
    );
    expect(new TextDecoder().decode(result)).toBe("rendered");
    expect(await readFile(blocked, "utf-8")).toBe("");
  });

  it("surfaces a render failure instead of caching it", async () => {
    await expect(
      throughCardCache(cache, { title: "A" }, () =>
        Promise.reject(new Error("takumi exploded"))
      )
    ).rejects.toThrow("takumi exploded");
    await expect(readdir(cache.dir)).rejects.toThrow();
  });
});

describe("pruneCardCache", () => {
  let cache: OgCache;

  beforeEach(async () => {
    resetCardCacheTally();
    cache = {
      dir: await mkdtemp(join(tmpdir(), "blume-og-prune-")),
      version: "1.0.0",
    };
  });

  afterEach(async () => {
    await rm(cache.dir, { force: true, recursive: true });
  });

  it("removes cards this build never requested and leftover temp files", async () => {
    await throughCardCache(cache, { title: "Kept" }, () =>
      Promise.resolve(png("kept"))
    );
    const stale = join(cache.dir, `${"f".repeat(64)}.png`);
    const tmp = join(cache.dir, `${"e".repeat(64)}.png.123.abc.tmp`);
    await writeFile(stale, "old");
    await writeFile(tmp, "partial");
    expect(await pruneCardCache(cache.dir)).toBe(2);
    const files = await readdir(cache.dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe(`${"f".repeat(64)}.png`);
  });

  it("removes nothing when the directory does not exist", async () => {
    expect(await pruneCardCache(join(cache.dir, "missing"))).toBe(0);
  });
});

describe("ogCacheDir", () => {
  it("uses node_modules/.cache when the project has a node_modules, else the runtime cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-og-dir-"));
    const context = { outDir: join(root, ".blume"), root };
    try {
      expect(ogCacheDir(context)).toBe(join(root, ".blume", ".cache", "og"));
      await writeFile(join(root, "node_modules"), "");
      expect(ogCacheDir(context)).toBe(
        join(root, "node_modules", ".cache", "blume", "og")
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
