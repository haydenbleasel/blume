import { describe, expect, it } from "bun:test";

import type { TableWrapPlugin } from "../src/markdown/table-wrap.ts";
import { tableWrapPlugin } from "../src/markdown/table-wrap.ts";

/** The plugin's own structural hast node type. */
type HastNode = Parameters<TableWrapPlugin["element"]["visit"]>[0];

const th = (children: HastNode[]): HastNode => ({
  children,
  tagName: "th",
  type: "element",
});

const thead = (cells: HastNode[]): HastNode => ({
  children: [
    { type: "text", value: "\n" },
    { children: cells, tagName: "tr", type: "element" },
    { type: "text", value: "\n" },
  ],
  tagName: "thead",
  type: "element",
});

const tableWith = (head: HastNode): HastNode => ({
  children: [head, { children: [], tagName: "tbody", type: "element" }],
  tagName: "table",
  type: "element",
});

describe("tableWrapPlugin", () => {
  it("targets only table elements", () => {
    expect(tableWrapPlugin().element.filter).toEqual(["table"]);
  });

  it("wraps a <table> in a scroll-container div and reuses the original node", () => {
    const table: HastNode = {
      children: [{ tagName: "tbody", type: "element" }],
      properties: { className: ["x"] },
      tagName: "table",
      type: "element",
    };
    const result = tableWrapPlugin().element.visit(table);

    expect(result?.tagName).toBe("div");
    expect(result?.type).toBe("element");
    expect(result?.properties?.className).toEqual(["blume-table-scroll"]);
    expect(result?.children).toEqual([table]);
  });

  it("makes the wrapper keyboard-focusable so it can be scrolled", () => {
    const table: HastNode = { tagName: "table", type: "element" };
    const result = tableWrapPlugin().element.visit(table);

    expect(result?.properties?.tabIndex).toBe(0);
  });

  it("drops a header row whose cells are all empty", () => {
    const table = tableWith(
      thead([th([]), th([{ type: "text", value: "  " }])])
    );
    const result = tableWrapPlugin().element.visit(table);

    expect(result?.children?.[0]?.children?.map((c) => c.tagName)).toEqual([
      "tbody",
    ]);
    // Satteri serializes an unchanged node by identity — the stripped table
    // must be a new object or the removal never reaches the output.
    expect(result?.children?.[0]).not.toBe(table);
  });

  it("keeps a header row with text in any cell", () => {
    const head = thead([th([]), th([{ type: "text", value: "Name" }])]);
    const table = tableWith(head);
    const result = tableWrapPlugin().element.visit(table);

    expect(result?.children?.[0]?.children?.[0]).toEqual(head);
  });

  it("keeps a header row whose only content is a non-text element", () => {
    const head = thead([
      th([{ children: [], properties: {}, tagName: "img", type: "element" }]),
    ]);
    const table = tableWith(head);
    const result = tableWrapPlugin().element.visit(table);

    expect(result?.children?.[0]?.children?.[0]).toEqual(head);
  });
});
