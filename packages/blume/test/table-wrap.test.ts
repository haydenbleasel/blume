import { describe, expect, it } from "bun:test";

import { tableWrapPlugin } from "../src/markdown/table-wrap.ts";

describe("tableWrapPlugin", () => {
  it("targets only table elements", () => {
    expect(tableWrapPlugin().element.filter).toEqual(["table"]);
  });

  it("wraps a <table> in a scroll-container div and reuses the original node", () => {
    const table = {
      children: [{ tagName: "tbody", type: "element" }],
      properties: { className: ["x"] },
      tagName: "table",
      type: "element",
    };
    const result = tableWrapPlugin().element.visit(table as never);

    expect(result?.tagName).toBe("div");
    expect(result?.type).toBe("element");
    expect(result?.properties?.className).toEqual(["blume-table-scroll"]);
    expect(result?.children).toEqual([table]);
  });

  it("makes the wrapper keyboard-focusable so it can be scrolled", () => {
    const table = { tagName: "table", type: "element" };
    const result = tableWrapPlugin().element.visit(table as never);

    expect(result?.properties?.tabIndex).toBe(0);
  });
});
