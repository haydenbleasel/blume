import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * Source checks for the tab widget's ARIA wiring. `<Tabs>` builds its strip in
 * an inline client script (no DOM in this suite), so these pin where the
 * `tabpanel` role is set: beside the tab that labels the panel, never on a
 * panel no tab points at.
 */

const source = (path: string): Promise<string> =>
  readFile(new URL(`../src/components/content/${path}`, import.meta.url), {
    encoding: "utf-8",
  });

/** The client script's tab-strip branch: where each trigger is wired. */
const stripBranch = (tabs: string): string => {
  const start = tabs.indexOf("const instance = ++instanceCount;");
  const end = tabs.indexOf(
    "this.activate(this.#initialIndex(), false, false);"
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return tabs.slice(start, end);
};

describe("tab panel roles", () => {
  it("gives every wired panel the tabpanel role its tab's aria-controls expects", async () => {
    // Panels adopted from CodeGroup fences, ts2js pairs, and nested groups
    // carry no role of their own, so the strip sets it alongside the label.
    const branch = stripBranch(await source("Tabs.astro"));
    expect(branch).toContain(
      'trigger.setAttribute("aria-controls", panel.id);'
    );
    expect(branch).toContain('panel.setAttribute("role", "tabpanel");');
    expect(branch).toContain(
      'panel.setAttribute("aria-labelledby", trigger.id);'
    );
  });

  it("leaves dropdown panels without a role, since no tab labels them", async () => {
    // `<Tab>` renders no role itself: in dropdown mode the script builds a
    // <select> instead of tabs, and a tabpanel with no tab is an orphan.
    const tab = await source("Tab.astro");
    expect(tab).not.toContain("tabpanel");
    const tabs = await source("Tabs.astro");
    expect(tabs.match(/"tabpanel"/gu)).toHaveLength(1);
  });
});
