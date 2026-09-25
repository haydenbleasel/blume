import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { scopesVersions } from "../src/search/adapters/version-scope.ts";

/**
 * Which search adapters scope results to the viewed docs version, and the
 * dialog's use of it: the "All versions" toggle only renders where it can
 * change the results.
 */

describe(scopesVersions, () => {
  it.each(["orama", "flexsearch", "algolia", "typesense"] as const)(
    "%s filters to one version",
    (kind) => {
      expect(scopesVersions(kind)).toBe(true);
    }
  );

  // Pagefind's index has no version metadata, the Orama Cloud sync uploads
  // none, and the Mixedbread endpoint takes no filter.
  it.each(["pagefind", "orama-cloud", "mixedbread", "none"] as const)(
    "%s always searches every version",
    (kind) => {
      expect(scopesVersions(kind)).toBe(false);
    }
  );
});

describe("search dialog version toggle", () => {
  it("drops the viewed version when the provider can't scope by it", async () => {
    const source = await readFile(
      new URL("../src/components/layout/Search.astro", import.meta.url),
      { encoding: "utf-8" }
    );
    expect(source).toMatch(
      /const version = scopesVersions\(data\.config\.search\.provider\)\s+\? viewedVersion\s+: null;/u
    );
    // The toggle and the client's version filter both key off that value.
    expect(source).toContain("{version !== null && (");
    expect(source).toContain(
      'data-versioned={version === null ? undefined : ""}'
    );
  });
});
