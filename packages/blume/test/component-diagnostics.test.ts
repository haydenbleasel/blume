import { describe, expect, it } from "bun:test";

import {
  missingExampleDiagnostics,
  validateUsedComponents,
} from "../src/core/component-diagnostics.ts";
import {
  extractComponentTags,
  extractExampleUses,
} from "../src/core/sources/normalize.ts";
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

describe("extractExampleUses", () => {
  it("reads each literal <Component path>, wrapped or not, outside code", () => {
    const body = [
      'Intro <Component path="counter" /> and',
      "<Component",
      "  title='x'",
      "  path='forms/login'",
      "/>",
      "<Component path={dynamic} />",
      '`<Component path="inline" />`',
      "```mdx",
      '<Component path="fenced" />',
      "```",
      '<ComponentGroup path="other" />',
    ].join("\n");
    expect(extractExampleUses(body, 3)).toStrictEqual([
      { column: 24, line: 4, path: "counter" },
      { column: 9, line: 7, path: "forms/login" },
    ]);
  });

  it("finds nothing in a body with no <Component>", () => {
    expect(extractExampleUses("# Hi\n\n<Card />\n")).toStrictEqual([]);
  });
});

describe("missingExampleDiagnostics", () => {
  it("warns once for each <Component path> that names no example", () => {
    const uses = [
      { column: 18, line: 6, path: "counter" },
      { column: 18, line: 8, path: "forms/missing" },
    ];
    const result = missingExampleDiagnostics(
      [
        page({
          examplesUsed: uses,
          route: "/a",
          sourcePath: "/site/docs/a.mdx",
        }),
        // A file shared by every locale renders once per locale.
        page({
          examplesUsed: uses,
          route: "/fr/a",
          sourcePath: "/site/docs/a.mdx",
        }),
        // One an `<include>` brought in reports against the partial.
        page({
          examplesUsed: [
            { column: 5, file: "/site/docs/_part.mdx", line: 2, path: "gone" },
          ],
          route: "/b",
        }),
      ],
      { dir: "/site/examples", examples: [{ path: "counter" }] },
      "/site",
      new Set(["Counter"])
    );
    expect(
      result.map((diagnostic) => [
        diagnostic.code,
        diagnostic.file,
        diagnostic.line,
        diagnostic.column,
        diagnostic.message,
      ])
    ).toStrictEqual([
      [
        "BLUME_EXAMPLE_NOT_FOUND",
        "/site/docs/a.mdx",
        8,
        18,
        '<Component path="forms/missing"> in /a names no example, so the page shows "No example found" in its place.',
      ],
      [
        "BLUME_EXAMPLE_NOT_FOUND",
        "/site/docs/_part.mdx",
        2,
        5,
        '<Component path="gone"> in /b names no example, so the page shows "No example found" in its place.',
      ],
    ]);
    expect(result[0]?.suggestion).toBe(
      "Fix the path, or add the example under examples/: `path` is its location there, without the extension."
    );
  });

  it("checks nothing when the project replaces <Component>", () => {
    const result = missingExampleDiagnostics(
      [page({ examplesUsed: [{ column: 1, line: 1, path: "anything" }] })],
      { dir: "/site/examples", examples: [] },
      "/site",
      new Set(["Component"])
    );
    expect(result).toStrictEqual([]);
  });
});
