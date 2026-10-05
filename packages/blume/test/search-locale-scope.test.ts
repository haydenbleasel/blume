import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { scopesLocales } from "../src/search/adapters/locale-scope.ts";

/**
 * Which search adapters scope results to the page's language, and the
 * dialog's use of it: the "All languages" toggle only renders where it can
 * change the results.
 */

describe(scopesLocales, () => {
  it.each([
    "orama",
    "flexsearch",
    "pagefind",
    "algolia",
    "orama-cloud",
    "typesense",
  ] as const)("%s filters to one language", (kind) => {
    expect(scopesLocales(kind)).toBe(true);
  });

  // The Mixedbread endpoint takes no filter.
  it.each(["mixedbread", "none"] as const)(
    "%s always searches every language",
    (kind) => {
      expect(scopesLocales(kind)).toBe(false);
    }
  );
});

describe("search dialog language toggle", () => {
  it("drops the page's locale when the provider can't scope by it", async () => {
    const source = await readFile(
      new URL("../src/components/layout/Search.astro", import.meta.url),
      { encoding: "utf-8" }
    );
    expect(source).toMatch(
      /const locale = scopesLocales\(data\.config\.search\.provider\)\s+\? viewedLocale\s+: undefined;/u
    );
    // The toggle and the client's locale filter both key off that value.
    expect(source).toContain("{locale && (");
    expect(source).toContain("data-locale={locale || undefined}");
  });
});
