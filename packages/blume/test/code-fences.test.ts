import { describe, expect, it } from "bun:test";

import { nextFenceState } from "../src/core/code-fences.ts";
import type { FenceState } from "../src/core/code-fences.ts";

/** The quote depth of the fence open after each of `lines`, or null. */
const depths = (lines: string[]): (number | null)[] => {
  let fence: FenceState = null;
  return lines.map((line) => {
    fence = nextFenceState(line, fence);
    return fence === null ? null : fence.quotes;
  });
};

/** Whether a fence is open after each of `lines`, with or without math. */
const open = (lines: string[], math: boolean): boolean[] => {
  let fence: FenceState = null;
  return lines.map((line) => {
    fence = nextFenceState(line, fence, math);
    return fence !== null;
  });
};

describe(nextFenceState, () => {
  it("reads a fence inside a block quote past its markers", () => {
    expect(
      depths([
        "> ```ts",
        "> interface X {",
        ">   [key: string]: string;",
        "> }",
        "> ```",
        "> [after](/x)",
      ])
    ).toStrictEqual([1, 1, 1, 1, null, null]);
  });

  it("closes a quoted fence where its quote ends", () => {
    // Code takes no lazy continuation lines, so a line without the marker
    // ends the quote and the fence it holds. That line can open a fence of
    // its own.
    expect(
      depths(["> ```", "> code", "after the quote", ">```", "```"])
    ).toStrictEqual([1, 1, null, 1, 0]);
  });

  it("reads a nested quote's fence past every marker it opened under", () => {
    expect(
      depths([
        "> > ~~~",
        "> > code",
        "> > ~~~",
        "> > ~~~",
        "> ~~~",
        "> code in the outer quote",
        "> ~~~",
      ])
    ).toStrictEqual([2, 2, null, 2, 1, 1, null]);
    // A deeper marker inside the fence is code, not a closer.
    expect(depths(["> ```", "> > ```", "> ```", "text"])).toStrictEqual([
      1,
      1,
      null,
      null,
    ]);
  });

  it("keeps a quoted line inside an unquoted fence as code", () => {
    expect(depths(["```md", "> ```", "> quoted", "```", "x"])).toStrictEqual([
      0,
      0,
      0,
      null,
      null,
    ]);
  });

  it("reads `$$` block math as a fence only when asked", () => {
    const block = ["$$", String.raw`\sum_{i=1}^{n}`, "$$", "after"];
    expect(open(block, true)).toStrictEqual([true, true, false, false]);
    expect(open(block, false)).toStrictEqual([false, false, false, false]);
    // A `$` after the run makes the line inline math, and a closer must be a
    // bare run at least as long as the opener.
    expect(
      open(["$$x$$", "$$ tex", "$$ x", "$$$", "$$$$", "$$"], true)
    ).toStrictEqual([false, true, true, false, true, true]);
    // Math and code each hold the other's delimiter as content.
    expect(open(["$$", "```", "$$", "```", "$$", "```"], true)).toStrictEqual([
      true,
      true,
      false,
      true,
      true,
      false,
    ]);
    // A quoted math block ends with its quote.
    expect(open(["> $$", "> x", "after"], true)).toStrictEqual([
      true,
      true,
      false,
    ]);
  });
});
