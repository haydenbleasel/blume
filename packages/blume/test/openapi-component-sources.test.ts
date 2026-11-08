import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * Source-level guards for the reference components whose behavior lives in
 * `.astro` templates and custom-element scripts the test runner can't render:
 * the `@specifiedBy` link filter, the panel tabs' keyboard pattern, and the
 * logical (RTL-safe) spacing utilities.
 */

const source = async (path: string): Promise<string> => {
  const text = await readFile(
    new URL(`../src/components/openapi/${path}`, import.meta.url),
    "utf-8"
  );
  // A Windows checkout may carry CRLF line endings.
  return text.replaceAll("\r\n", "\n");
};

describe("GraphqlType", () => {
  it("links a @specifiedBy URL only when its scheme is safe", async () => {
    const type = await source("GraphqlType.astro");
    expect(type).toContain(
      'import { isSafeHref } from "../../core/safe-href.ts";'
    );
    expect(type).toContain("isSafeHref(type.specifiedByUrl) ? (");
    // The only href on the page is the guarded one.
    expect(type.match(/href=\{type\.specifiedByUrl\}/gu)).toHaveLength(1);
  });
});

describe("PanelTabs", () => {
  it("names the tablist and roves tabindex across the tabs", async () => {
    const tabs = await source("PanelTabs.astro");
    expect(tabs).toContain(
      'aria-label={heading} class="flex flex-wrap gap-4" role="tablist"'
    );
    expect(tabs).toContain('tabindex={index === 0 ? "0" : "-1"}');
  });

  it("moves between tabs with the arrow keys, Home, and End", async () => {
    const panel = await source("panel.ts");
    for (const key of ["Home", "End"]) {
      expect(panel).toContain(`event.key === "${key}"`);
    }
    // The arrows swap under dir="rtl", as they do in `<Tabs>`.
    expect(panel).toContain(
      'const rtl = getComputedStyle(this).direction === "rtl";'
    );
    expect(panel).toContain('event.key === (rtl ? "ArrowLeft" : "ArrowRight")');
    expect(panel).toContain('event.key === (rtl ? "ArrowRight" : "ArrowLeft")');
    expect(panel).toContain("tab.tabIndex = selected ? 0 : -1;");
    expect(panel).toContain("target.focus();");
  });

  it("hosts the code Ask button in the header, never over the code", async () => {
    // The layout script used to pin an Ask button over every panel's code,
    // where it hid the end of the first line (#425). It now joins Copy in
    // the header and reads whichever panel shows.
    const [tabs, root] = await Promise.all([
      source("PanelTabs.astro"),
      readFile(
        new URL("../src/components/layout/RootLayout.astro", import.meta.url),
        "utf-8"
      ).then((text) => text.replaceAll("\r\n", "\n")),
    ]);
    expect(tabs).toMatch(
      /<div class="flex shrink-0 items-center gap-1" data-panel-actions>\s*\{copy && \(/u
    );
    expect(tabs).not.toContain("[data-blume-copy]");
    // A plain-text panel (no example response) has no code to ask about.
    expect(tabs).toContain(
      'class="px-3 py-4 text-muted-foreground text-xs" data-panel-text'
    );
    expect(tabs).toContain(
      "blume-panel-tabs:has(> [data-panel]:not(.hidden) > [data-panel-text])\n    [data-blume-ask] {\n    display: none;"
    );
    // The panel branch runs before the overlay buttons and skips them.
    const start = root.indexOf(
      'const panelTabs = pre.closest("blume-panel-tabs");'
    );
    const end = root.indexOf("const topClass =");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(end);
    const branch = root.slice(start, end);
    expect(branch).toMatch(
      /actions\.prepend\(\s*createAskButton\("", \(\) => activePanelPre\(panelTabs\)\)\s*\);\s*\}\s*continue;\s*\}/u
    );
    expect(branch).toContain("pre.dataset.blumeLanguage ??= sampleLang;");
  });
});

describe("ParametersTable", () => {
  it("falls back to the schema's description, as the Try it panel does", async () => {
    const table = await source("ParametersTable.astro");
    expect(table).toContain(
      "const description = parameterDescription(param, schemas);"
    );
    expect(table).not.toContain("param.description");
  });
});

describe("logical spacing", () => {
  it("uses no physical left/right utilities", async () => {
    const files = [
      "MessageComposer.astro",
      "Playground.astro",
      "SchemaProperty.astro",
      "playground-client.ts",
    ];
    const physical =
      /(?<![\w-])(?:m[lr]|p[lr]|border-[lr]|text-(?:left|right))(?:-[\d.]+)?(?![\w-])/u;
    const sources = await Promise.all(files.map(source));
    expect(
      sources.map((text, index) => [files[index], physical.exec(text)?.[0]])
    ).toStrictEqual(files.map((file) => [file, undefined]));
  });
});
