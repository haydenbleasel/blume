import { describe, expect, it } from "bun:test";

import { validateUsedComponents } from "../src/core/component-diagnostics.ts";
import { extractComponentTags } from "../src/core/sources/normalize.ts";
import type { PageRecord } from "../src/core/types.ts";

const page = (over: Partial<PageRecord>): PageRecord =>
  // SAFETY: the validators under test read only the fields a fixture sets
  // (id, route, and the overrides); the remaining PageRecord fields go unread.
  ({ id: "p", route: "/p", ...over }) as PageRecord;

describe("extractComponentTags", () => {
  it("finds capitalized JSX tags and the base of a member tag", () => {
    expect(
      extractComponentTags("<Callout>hi</Callout>\n<Tree.File />").toSorted()
    ).toEqual(["Callout", "Tree"]);
  });

  it("ignores lowercase tags, fenced/inline code, and double-quoted text", () => {
    const body = [
      "<div>not a component</div>",
      "```tsx",
      "<InCode />",
      "```",
      "inline `<AlsoCode />` here",
      'a note "<InQuotes /> integration"',
    ].join("\n");
    expect(extractComponentTags(body)).toEqual([]);
  });

  it("ignores tags inside tilde-fenced code", () => {
    const body = ["~~~tsx", "<InTildeFence />", "~~~", "<Real />"].join("\n");
    expect(extractComponentTags(body)).toEqual(["Real"]);
  });
});

describe("validateUsedComponents", () => {
  it("warns on an unknown tag, allowing built-ins and known extras", () => {
    const result = validateUsedComponents(
      [page({ componentsUsed: ["Callout", "Counter", "Bogus"] })],
      new Set(["Counter"]),
      new Set()
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe("BLUME_UNKNOWN_COMPONENT");
    expect(result[0]?.message).toContain("Bogus");
  });

  it("suggests `blume add` when the tag matches a registry item", () => {
    // A layout registry item (`Pagination`) isn't a globally-available built-in.
    const result = validateUsedComponents(
      [page({ componentsUsed: ["Pagination"] })],
      new Set(),
      new Set(["pagination"])
    );
    expect(result[0]?.suggestion).toContain("blume add pagination");
  });

  it("dedupes a repeated unknown tag across pages", () => {
    const result = validateUsedComponents(
      [
        page({ componentsUsed: ["Bogus"], route: "/a" }),
        page({ componentsUsed: ["Bogus"], route: "/b" }),
      ],
      new Set(),
      new Set()
    );
    expect(result).toHaveLength(1);
  });
});
