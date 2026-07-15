import { describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import { pollingWatch } from "../src/core/sources/cache.ts";
import type { SourceLoadResult } from "../src/core/sources/types.ts";
import {
  baselineScanIgnore,
  BLUME_IGNORE_DIRS,
  BLUME_WATCH_IGNORE_DIRS,
  excludeDirSegments,
  ignoringWatchListener,
} from "../src/core/sources/watch.ts";

describe("excludeDirSegments", () => {
  it("extracts single-segment dir prefixes from `foo/**` excludes", () => {
    expect(
      excludeDirSegments([
        "node_modules/**",
        ".blume/**",
        "snippets/**",
        "public/**",
      ])
    ).toEqual(["node_modules", ".blume", "snippets", "public"]);
  });

  it("ignores glob/file excludes that aren't a plain dir prefix", () => {
    expect(
      excludeDirSegments([
        "**/_*",
        "**/.*",
        "README.md",
        "**/node_modules/**",
        "a/b/**",
      ])
    ).toEqual([]);
  });
});

describe("ignoringWatchListener", () => {
  it("drops events under Blume's own output and other ignored trees", () => {
    let calls = 0;
    const listener = ignoringWatchListener(() => {
      calls += 1;
    });

    // The default set stops the migrated-project regeneration loop: the dev
    // server rewrites these on every render and must not re-trigger a scan.
    listener("change", ".blume/.astro/data-store.json");
    listener("change", ".blume/.astro/data-store.json.tmp");
    listener("change", "packages/x/node_modules/dep/index.js");
    listener("change", ".git/HEAD");
    // The isolated check runtime is written while dev runs; it must not reload.
    listener("change", ".blume-verify/src/generated/data.json");
    // Windows-style separators are handled too.
    listener("change", ".blume\\.astro\\settings.json");
    expect(calls).toBe(0);

    // Real content edits (and an unnameable path) still regenerate.
    listener("change", "guides/intro.mdx");
    listener("rename", null);
    expect(calls).toBe(2);
  });

  it("honors a custom ignore set", () => {
    let calls = 0;
    const listener = ignoringWatchListener(() => {
      calls += 1;
    }, ["dist"]);

    // Not in the custom set: `.blume` is no longer ignored here.
    listener("change", ".blume/.astro/data-store.json");
    listener("change", "dist/index.html");
    expect(calls).toBe(1);
  });

  it("always ships the loop-critical dirs in its default set", () => {
    expect(BLUME_WATCH_IGNORE_DIRS).toContain(".blume");
    expect(BLUME_WATCH_IGNORE_DIRS).toContain(".blume-verify");
    expect(BLUME_WATCH_IGNORE_DIRS).toContain("node_modules");
    expect(BLUME_WATCH_IGNORE_DIRS).toContain(".git");
  });
});

const loadResult = (text: string): Promise<SourceLoadResult> =>
  Promise.resolve({
    diagnostics: [],
    entries: [{ body: { format: "md", text }, data: {}, ref: "a.md" }],
  });

describe("pollingWatch", () => {
  it("fires when a fresh poll diverges from the seeded baseline", async () => {
    let changes = 0;
    // The seed is what dev actually served (A); the remote already moved to B
    // before the first tick — that first change must not be swallowed.
    const stop = pollingWatch(
      () => loadResult("B"),
      0.01,
      () => loadResult("A")
    )(() => {
      changes += 1;
    });
    await sleep(60);
    stop();
    expect(changes).toBe(1);
  });

  it("stays quiet while polls keep returning the served content", async () => {
    let changes = 0;
    const stop = pollingWatch(
      () => loadResult("A"),
      0.01,
      () => loadResult("A")
    )(() => {
      changes += 1;
    });
    await sleep(60);
    stop();
    expect(changes).toBe(0);
  });
});

describe("baselineScanIgnore", () => {
  it("covers dependency, output, and cache trees the scan must never read", () => {
    for (const dir of [".blume", ".vercel", "dist", "node_modules"]) {
      expect(BLUME_IGNORE_DIRS).toContain(dir);
    }
    // Watcher and scan share one canonical set so they never disagree.
    expect(BLUME_WATCH_IGNORE_DIRS).toBe(BLUME_IGNORE_DIRS);
  });

  it("emits recursive globs matching each dir at the root or nested", () => {
    expect(baselineScanIgnore()).toContain("**/node_modules/**");
    expect(baselineScanIgnore()).toContain("**/dist/**");
    expect(baselineScanIgnore()).toStrictEqual(
      BLUME_IGNORE_DIRS.map((dir) => `**/${dir}/**`)
    );
  });
});
