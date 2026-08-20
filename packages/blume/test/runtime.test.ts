import { describe, expect, it } from "bun:test";

import type { BlumeData, BlumeRoute } from "../src/core/data.ts";
import { getBlumeCollection } from "../src/runtime/index.ts";

const route = (over: Partial<BlumeRoute>): BlumeRoute => ({
  alternates: [],
  collection: "docs",
  draft: false,
  editUrl: null,
  entryId: over.id ?? "id",
  fallback: false,
  hidden: false,
  id: "id",
  indexable: true,
  lastModified: null,
  locale: "en",
  path: "/",
  title: "",
  version: "",
  versionAlternates: [],
  ...over,
});

// SAFETY: getBlumeCollection reads only the routes list.
const data = (routes: BlumeRoute[]): BlumeData => ({ routes }) as BlumeData;

describe("getBlumeCollection", () => {
  it("returns docs routes sorted by path, excluding hidden ones", () => {
    const result = getBlumeCollection(
      data([
        route({ id: "b", path: "/b", title: "B" }),
        route({ id: "a", path: "/a", title: "A" }),
        route({ draft: true, id: "d", path: "/d" }),
        route({ hidden: true, id: "h", path: "/h" }),
        route({ fallback: true, id: "f", path: "/f" }),
      ])
    );
    expect(result.map((r) => r.path)).toEqual(["/a", "/b"]);
  });

  it("filters by path prefix", () => {
    const result = getBlumeCollection(
      data([
        route({ id: "1", path: "/blog/one" }),
        route({ id: "2", path: "/docs/intro" }),
      ]),
      { prefix: "/blog" }
    );
    expect(result.map((r) => r.path)).toEqual(["/blog/one"]);
  });

  it("filters by collection and locale", () => {
    const result = getBlumeCollection(
      data([
        route({ collection: "staged", id: "s", locale: "en", path: "/s" }),
        route({ collection: "docs", id: "en", locale: "en", path: "/en" }),
        route({ collection: "docs", id: "fr", locale: "fr", path: "/fr" }),
      ]),
      { collection: "docs", locale: "fr" }
    );
    expect(result.map((r) => r.id)).toEqual(["fr"]);
  });

  it("includes hidden pages when asked", () => {
    const result = getBlumeCollection(
      data([route({ draft: true, id: "d", path: "/d" })]),
      { includeHidden: true }
    );
    expect(result).toHaveLength(1);
  });
});
