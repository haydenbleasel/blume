import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { join } from "pathe";

import { extractComponentAnchors } from "../src/core/component-anchors.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";

const componentSource = (tag: string): string =>
  readFileSync(
    join(import.meta.dir, "../src/components/content", `${tag}.astro`),
    "utf-8"
  );

describe("component ids", () => {
  it("mirror what each component renders", () => {
    // `extractComponentAnchors` reimplements these; a change here must be
    // made there too.
    const accordionItem = componentSource("AccordionItem");
    expect(accordionItem).toContain(
      "const accordionId = id ?? componentSlug(title);"
    );
    expect(accordionItem).toContain(
      // oxlint-disable-next-line no-template-curly-in-string -- script source under test
      "accordion.id = `${accordion.id}-${count + 1}`;"
    );
    expect(componentSource("Expandable")).toContain(
      "<AccordionItem defaultOpen={defaultOpen} title={title}>"
    );
    const tab = componentSource("Tab");
    expect(tab).toContain("const tabId = id ?? componentSlug(title);");
    expect(tab).toContain("  id={id}\n");
    expect(tab).toContain("  data-tab-id={tabId}\n");
    const tabs = componentSource("Tabs");
    expect(tabs).toContain("  hash = true,\n");
    expect(tabs).toContain("  data-param={param}\n");
    expect(tabs).toContain('const hashEnabled = String(hash) !== "false";');
    expect(tabs).toContain("return this.dataset.param || null;");
    expect(tabs).toContain(
      "const panelId = (panel: HTMLElement) => panel.dataset.tabId ?? panel.id;"
    );
    expect(tabs).toContain(
      'panel.classList.toggle("hidden", panelIndex !== index);'
    );
    expect(componentSource("CodeGroup")).toContain(
      "<Tabs dropdown={dropdown} hash={false}>"
    );
    for (const tag of ["RequestExample", "ResponseExample"]) {
      expect(componentSource(tag)).toContain("<CodeGroup dropdown={dropdown}>");
    }
    const visibility = componentSource("Visibility");
    expect(visibility).toContain('const { for: audience = "humans" }');
    expect(visibility).toContain('const visibleOnWeb = audience !== "agents";');
  });
});

describe(extractComponentAnchors, () => {
  it("reads an accordion's id, or else its title slugged", () => {
    const body = [
      "<Accordion>",
      '  <AccordionItem id="group-policy" title="This program is blocked by group policy">',
      "    Text.",
      "  </AccordionItem>",
      '  <AccordionItem title="Checksumman stämmer inte (EINTEGRITY)">',
      "    Text.",
      "  </AccordionItem>",
      '  <AccordionItem title="The `base` option">Text.</AccordionItem>',
      "</Accordion>",
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([
      "group-policy",
      "checksumman-stämmer-inte-eintegrity",
      "the-base-option",
    ]);
  });

  it("gives an expandable its title's slug", () => {
    const body = [
      '<Expandable title="Show advanced options">x</Expandable>',
      // The untitled one shows a localized label, so it has no fixed id.
      "<Expandable>y</Expandable>",
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([
      "show-advanced-options",
    ]);
  });

  it("takes a tab's id, and its title's slug where the group opens from the hash", () => {
    const body = [
      "<Tabs>",
      '  <Tab id="windows-setup" title="Windows">a</Tab>',
      '  <Tab title="Linux">b</Tab>',
      "</Tabs>",
      '<Tabs hash="true" param="">',
      '  <Tab id="windows-setup" title="Windows">c</Tab>',
      '  <Tab title="macOS">d</Tab>',
      "</Tabs>",
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([
      "windows-setup",
      "linux",
      "macos",
    ]);
  });

  it("takes only a tab's id in a group that doesn't open from the hash", () => {
    const body = [
      // An id is on the page, open or not; a title slug is only a hash key.
      "<Tabs hash={false}>",
      '  <Tab id="off" title="A">a</Tab>',
      '  <Tab title="Off expression">b</Tab>',
      "</Tabs>",
      '<Tabs hash="false"><Tab title="Off string">c</Tab></Tabs>',
      '<Tabs param="os"><Tab title="In the query">d</Tab></Tabs>',
      '<Tabs param={0}><Tab title="Param zero">d</Tab></Tabs>',
      '<Tabs hash={on}><Tab id="unknown" title="Unknown hash">e</Tab></Tabs>',
      '<CodeGroup><Tab title="Code">f</Tab></CodeGroup>',
      '<RequestExample><Tab title="Request">f</Tab></RequestExample>',
      '<ResponseExample><Tab title="Response">f</Tab></ResponseExample>',
      // The nearest group decides.
      '<Tabs hash={false}><Tab title="Outer">',
      "",
      '<Tabs><Tab title="Inner">g</Tab></Tabs>',
      "",
      "</Tab></Tabs>",
      '<Tabs><Tab title="Py">',
      "",
      '<CodeGroup><Tab title="Sync">h</Tab></CodeGroup>',
      "",
      "</Tab></Tabs>",
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([
      "off",
      "unknown",
      "inner",
      "py",
    ]);
  });

  it("takes a tab's id, not its title, outside a group", () => {
    const body = [
      '<Tab id="alone" title="Alone">a</Tab>',
      '<Tab title="No group">b</Tab>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual(["alone"]);
  });

  it("reads a null or empty param as no param, and any other as one", () => {
    const body = [
      '<Tabs param={null}><Tab title="Null">a</Tab></Tabs>',
      '<Tabs param=""><Tab title="Empty">b</Tab></Tabs>',
      // `data-param` renders `false` and `true` as text, which the script reads.
      '<Tabs param={false}><Tab title="False">c</Tab></Tabs>',
      '<Tabs param><Tab title="Bare">d</Tab></Tabs>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual(["null", "empty"]);
  });

  it("reads a null id as unset and a number as the string it renders", () => {
    const body = [
      '<AccordionItem id={null} title="Null id">a</AccordionItem>',
      '<AccordionItem id={1} title="x">b</AccordionItem>',
      '<Tabs><Tab id={null} title="Null tab">c</Tab><Tab id={2} title="x">d</Tab></Tabs>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([
      "null-id",
      "1",
      "null-tab",
      "2",
    ]);
  });

  it("skips a tag the page imports or exports, and what it holds", () => {
    const body = [
      'import Def, { Tab as Pane, "x-y" as Q } from "./Tab.astro";',
      'import * as Tabs from "./os.js";',
      'import "./side.css";',
      'export const meta = { label: "Expandable" }, AccordionItem = 1;',
      "",
      '<Tabs><Tab title="Inside">a</Tab></Tabs>',
      '<AccordionItem title="Mine">b</AccordionItem>',
      '<Expandable title="Kept">c</Expandable>',
      '<Tab id="tab-kept" title="x">d</Tab>',
      '<Pane id="pane">e</Pane>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual(["kept", "tab-kept"]);
  });

  it("finds the page's own components by how its statements bind them", () => {
    const body = [
      'import AccordionItem from "./Mine.astro";',
      'import type { Tab } from "./types.ts";',
      'export { default as Tabs } from "./os.js";',
      'export { Expandable } from "./ui.js";',
      'export const later = () => import("./Visibility.js");',
      "export type Step = string;",
      "",
      '<AccordionItem title="Mine">a</AccordionItem>',
      '<Tabs><Tab title="Built in">b</Tab></Tabs>',
      '<Expandable title="Re-exported">c</Expandable>',
    ].join("\n");
    // A default import binds; a type import, a re-export, and a dynamic
    // `import()` bind nothing, so those tags stay the built-ins.
    expect(extractComponentAnchors(body)).toStrictEqual([
      "re-exported",
      "built-in",
    ]);
  });

  it("finds a binding with comments around it", () => {
    const body = [
      "import {",
      "  // ours",
      "  AccordionItem",
      '} from "./a.jsx";',
      'import /* ours */ Expandable from "./b.jsx";',
      "",
      '<AccordionItem id="x" title="X">a</AccordionItem>',
      '<Expandable title="Y">b</Expandable>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([]);
  });

  it("walks only content that renders", () => {
    const body = [
      'import * as ui from "./ui.jsx";',
      "",
      '<ui.Hidden><AccordionItem id="member" title="x">a</AccordionItem></ui.Hidden>',
      '<YouTube id="abc"><AccordionItem id="youtube" title="x">b</AccordionItem></YouTube>',
      '<MyCard><AccordionItem id="custom" title="x">c</AccordionItem></MyCard>',
      '<template><AccordionItem id="template" title="x">d</AccordionItem></template>',
      '<noscript><AccordionItem id="noscript" title="x">e</AccordionItem></noscript>',
      'Ratio :abbr[<AccordionItem id="text-directive" title="x" />] here.',
      "",
      '::video[<AccordionItem id="leaf-directive" title="x" />]',
      "",
      ":::note",
      '<AccordionItem id="container" title="x">f</AccordionItem>',
      ":::",
      "",
      '<div><AccordionItem id="html" title="x">g</AccordionItem></div>',
      '<Steps><Step title="s"><AccordionItem id="step" title="x">h</AccordionItem></Step></Steps>',
      '<><AccordionItem id="fragment" title="x">i</AccordionItem></>',
      '<CodeBlock code="npm i" lang="sh"><AccordionItem id="code" title="x">j</AccordionItem></CodeBlock>',
      '<CodeBlock lang="sh"><AccordionItem id="code-slot" title="x">k</AccordionItem></CodeBlock>',
      '<textarea><AccordionItem id="textarea" title="x">l</AccordionItem></textarea>',
      '<script><AccordionItem id="script" title="x">m</AccordionItem></script>',
      "",
      ':::note[Read <Expandable title="Label" />]',
      "Body.",
      ":::",
      "",
      'Text.\n\n[^1]: <Expandable title="Unreferenced footnote">n</Expandable>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([
      "container",
      "html",
      "step",
      "fragment",
      "code-slot",
    ]);
  });

  it("reads an object or array hash as not opening from the hash", () => {
    const body = [
      '<Tabs hash={{ toString: 1 }}><Tab title="Object">a</Tab></Tabs>',
      '<Tabs hash={["x"]}><Tab title="Array">b</Tab></Tabs>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([]);
  });

  it("reads an import with a phase keyword, and one without a space as text", () => {
    const body = [
      // Without a space after `import`, MDX reads the line as a paragraph.
      'import*as Tabs from"./x.js"',
      "",
      'import defer * as AccordionItem from "./y.js";',
      "",
      '<Tabs><Tab title="Built in">a</Tab></Tabs>',
      '<AccordionItem title="Mine">b</AccordionItem>',
      '<Expandable title="Kept">c</Expandable>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual(["kept", "built-in"]);
  });

  it("gives none, rather than throw, for nesting deep enough to overflow", () => {
    const body = `${"> ".repeat(30_000)}<AccordionItem id="deep" title="x" />\n`;
    expect(extractComponentAnchors(body)).toStrictEqual([]);
  });

  it("gives none when the page's statements can't be read", () => {
    const body =
      'import { from "x";\n\n<AccordionItem title="x">a</AccordionItem>\n';
    expect(extractComponentAnchors(body)).toStrictEqual([]);
  });

  it("suffixes repeated accordion ids, as the accordion script does", () => {
    const body = [
      '<AccordionItem title="Bug fixes">a</AccordionItem>',
      '<Expandable title="Bug fixes">b</Expandable>',
      '<AccordionItem id="bug-fixes" title="x">c</AccordionItem>',
      // `<Update>` isn't an MDX component, so it is the project's own.
      '<Update label="Bug fixes">d</Update>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([
      "bug-fixes",
      "bug-fixes-2",
      "bug-fixes-3",
    ]);
  });

  it("reads static expressions as the strings they render", () => {
    const body = [
      '<AccordionItem id={"double"} title="x">a</AccordionItem>',
      "<AccordionItem id={'single'} title=\"x\">b</AccordionItem>",
      "<AccordionItem title={`Template $ text`}>c</AccordionItem>",
      '<AccordionItem title={"Escaped \\" quote"}>d</AccordionItem>',
      "<AccordionItem title={frontmatter.faq}>e</AccordionItem>",
    ].join("\n");
    expect(
      extractComponentAnchors(body, { faq: "From front matter" })
    ).toStrictEqual([
      "double",
      "single",
      "template--text",
      "escaped--quote",
      "from-front-matter",
    ]);
  });

  it("lets the last of a repeated prop win, as JSX does", () => {
    const body =
      '<AccordionItem id="first" id="second" title="x">a</AccordionItem>\n';
    expect(extractComponentAnchors(body)).toStrictEqual(["second"]);
  });

  it("reads the id prop, not one like data-id", () => {
    const body = [
      '<Tab data-id="x" title="Linux">a</Tab>',
      "<Tabs><Tab data-id='y'>b</Tab></Tabs>",
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([]);
  });

  it("skips ids it can't know, boolean ids, and ids that never render", () => {
    const body = [
      '<AccordionItem id={name} title="x">a</AccordionItem>',
      // oxlint-disable-next-line no-template-curly-in-string -- MDX source under test
      "<AccordionItem title={`Hi ${name}`}>b</AccordionItem>",
      "<AccordionItem title={frontmatter.missing}>c</AccordionItem>",
      "<AccordionItem title={42}>c</AccordionItem>",
      '<AccordionItem {...props} title="Spread">d</AccordionItem>',
      '<AccordionItem id title="Bare">e</AccordionItem>',
      '<AccordionItem id="" title="Empty">f</AccordionItem>',
      '<Tab id={tabId} title="T">h</Tab>',
      "",
      "```mdx",
      '<AccordionItem id="in-a-fence" title="x">i</AccordionItem>',
      "```",
      "",
      'Write `<AccordionItem id="inline" title="x">` for one.',
      "",
      '{/* <AccordionItem id="commented" title="x">j</AccordionItem> */}',
      "",
      "<Prompt>",
      '<AccordionItem id="in-a-prompt" title="x">k</AccordionItem>',
      "</Prompt>",
      "",
      '<Visibility for="agents">',
      '<AccordionItem id="for-agents" title="x">l</AccordionItem>',
      "</Visibility>",
      "",
      "<Visibility for={audience}>",
      '<AccordionItem id="for-someone" title="x">m</AccordionItem>',
      "</Visibility>",
      "",
      "<Visibility>",
      '<AccordionItem id="for-humans" title="x">n</AccordionItem>',
      "</Visibility>",
      "",
      // The rest of the page still parses and counts.
      '<AccordionItem title="Control">o</AccordionItem>',
    ].join("\n");
    expect(extractComponentAnchors(body)).toStrictEqual([
      "for-humans",
      "control",
    ]);
  });

  it("skips bodies with no candidate, and bodies MDX can't parse", () => {
    expect(extractComponentAnchors("# Title\n\nText.\n")).toStrictEqual([]);
    expect(
      extractComponentAnchors('<Steps><Step title="Linux">x</Step></Steps>\n')
    ).toStrictEqual([]);
    expect(
      extractComponentAnchors(
        '<AccordionItem id="x" title="y">\n\n<div>Unclosed\n'
      )
    ).toStrictEqual([]);
  });
});

describe("normalizeEntry component anchors", () => {
  const ctx = {
    defaultType: "doc",
    source: { name: "docs", staged: false },
  };
  const body = [
    '<a id="raw"></a>',
    "",
    "<Accordion>",
    '  <AccordionItem id="raw" title="Same as the raw id">a</AccordionItem>',
    '  <AccordionItem title="Slow installs">b</AccordionItem>',
    "  <AccordionItem title={frontmatter.description}>c</AccordionItem>",
    "</Accordion>",
    "",
  ].join("\n");
  const anchorsOf = (format: "md" | "mdx") =>
    normalizeEntry(
      {
        body: { format, text: body },
        data: { description: "Proxy errors", title: "Guide" },
        ref: `guide.${format}`,
        sourcePath: `/docs/guide.${format}`,
      },
      ctx
    ).pages[0]?.anchors;

  it("adds the ids built-in components render on .mdx pages", () => {
    expect(anchorsOf("mdx")).toStrictEqual([
      "raw",
      "slow-installs",
      "proxy-errors",
    ]);
  });

  it("leaves .md pages, which render no components, to raw HTML ids", () => {
    expect(anchorsOf("md")).toStrictEqual(["raw"]);
  });
});
