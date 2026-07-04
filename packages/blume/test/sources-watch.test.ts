import { describe, expect, it } from "bun:test";

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
    expect(BLUME_WATCH_IGNORE_DIRS).toContain("node_modules");
    expect(BLUME_WATCH_IGNORE_DIRS).toContain(".git");
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
