import { describe, expect, it } from "bun:test";

import { activeTocEntry } from "../src/components/layout/toc-active.ts";

/**
 * Tests for the table of contents' scrollspy choice
 * (`src/components/layout/toc-active.ts`), which `<blume-toc>` runs on every
 * scroll tick.
 */

const TRIGGER = 72;

/** A TOC entry whose heading sits `top` px from the viewport top. */
const entry = (id: string, top: number, rendered = true) => ({
  heading: {
    getBoundingClientRect: () => ({ top }),
    getClientRects: () => ({ length: rendered ? 1 : 0 }),
  },
  id,
});

/**
 * `## Install`, then `<Tabs>` holding `### Via npm` (the shown panel) and
 * `### Via pnpm` (a hidden panel), then `## Configure`, read at the top of
 * the page. A heading in a `display: none` panel has no boxes and measures
 * `top: 0`.
 */
const tabbedPage = (scroll: number) => [
  entry("install", 200 - scroll),
  entry("via-npm", 400 - scroll),
  entry("via-pnpm", 0, false),
  entry("configure", 900 - scroll),
];

describe(activeTocEntry, () => {
  it("defaults to the first heading before any reaches the trigger line", () => {
    expect(activeTocEntry(tabbedPage(0), TRIGGER, false)?.id).toBe("install");
  });

  it("never highlights a heading inside a hidden tab panel", () => {
    // Past "Via npm" but short of "Configure": the hidden "Via pnpm" measures
    // above the line, yet the section being read is still "Via npm".
    expect(activeTocEntry(tabbedPage(500), TRIGGER, false)?.id).toBe("via-npm");
    expect(activeTocEntry(tabbedPage(850), TRIGGER, false)?.id).toBe(
      "configure"
    );
  });

  it("picks the last rendered heading at the bottom of the page", () => {
    const entries = [...tabbedPage(0), entry("hidden-last", 0, false)];
    expect(activeTocEntry(entries, TRIGGER, true)?.id).toBe("configure");
  });

  it("is null when no heading is rendered", () => {
    const hidden = [entry("a", 0, false), entry("b", 0, false)];
    expect(activeTocEntry(hidden, TRIGGER, false)).toBeNull();
    expect(activeTocEntry(hidden, TRIGGER, true)).toBeNull();
    expect(activeTocEntry([], TRIGGER, false)).toBeNull();
  });
});
