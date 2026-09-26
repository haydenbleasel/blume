import { describe, expect, it } from "bun:test";

import { mdxToJs } from "satteri";
import type { MdastPluginDefinition } from "satteri";

import { downlevelComponents } from "../src/ai/component-markdown.ts";
import { catchAllPageTemplate } from "../src/astro/templates.ts";
import {
  chooseView,
  VIEW_INIT_SCRIPT,
  viewStyle,
} from "../src/components/content/view-switcher.ts";
import { VIEWS_KEY, viewsPlugin } from "../src/markdown/views.ts";
import type { PageView } from "../src/markdown/views.ts";

/**
 * `<View>` pages: the plugin that lists a page's views for its picker, the
 * picker's choice and per-page style, the inline script that applies a
 * choice before paint, and the views' agent-facing Markdown.
 */

const PAGE = [
  "Shared prose.",
  "",
  '<View title="JavaScript" icon="braces">',
  "",
  "## Install",
  "",
  "</View>",
  "",
  '<View title="Python">',
  "",
  "## Install",
  "",
  "</View>",
  "",
  "<Tabs>",
  '<Tab title="More">',
  '<View title="JavaScript" icon="ignored">Nested, and a repeat.</View>',
  "<View title={dynamic}>Not a literal title.</View>",
  '<View title="  ">Blank.</View>',
  "</Tab>",
  "</Tabs>",
].join("\n");

// SAFETY: the plugin models the slice of Satteri's visitor protocol it
// uses, as Blume's pipeline bridges it (see `asMdastPlugin` there).
const asMdastPlugin = (plugin: { name: string }): MdastPluginDefinition =>
  plugin as MdastPluginDefinition;

/** The render frontmatter the plugin leaves for `source`. */
const viewsOf = async (source: string, withFrontmatter = true) => {
  const data: Record<string, { frontmatter: Record<string, PageView[]> }> =
    withFrontmatter ? { astro: { frontmatter: {} } } : {};
  await mdxToJs(source, {
    data,
    mdastPlugins: [asMdastPlugin(viewsPlugin())],
  });
  return data;
};

describe(viewsPlugin, () => {
  it("lists each distinct literal title once, in first-use order, nested too", async () => {
    expect(await viewsOf(PAGE)).toStrictEqual({
      astro: {
        frontmatter: {
          [VIEWS_KEY]: [
            { icon: "braces", title: "JavaScript" },
            { title: "Python" },
          ],
        },
      },
    });
  });

  it("leaves a page with one view, or none, without a picker", async () => {
    expect(await viewsOf('<View title="Only">One.</View>\n')).toStrictEqual({
      astro: { frontmatter: {} },
    });
    expect(await viewsOf(PAGE, false)).toStrictEqual({});
  });
});

describe(chooseView, () => {
  const titles = ["JavaScript", "Python"];

  it("takes the first candidate the page has, else its first view", () => {
    expect(chooseView(titles, [undefined, "Go", "Python"])).toBe("Python");
    expect(chooseView(titles, [null, "JavaScript", "Python"])).toBe(
      "JavaScript"
    );
    expect(chooseView(titles, [])).toBe("JavaScript");
    expect(chooseView([], ["Python"])).toBeUndefined();
  });
});

describe(viewStyle, () => {
  it("hides every other view, the first before a choice", () => {
    expect(viewStyle(["A", "B"])).toBe(
      'body:not([data-blume-view]) [data-blume-view]:not([data-blume-view="A"]),body[data-blume-view="A"] [data-blume-view]:not([data-blume-view="A"]),body[data-blume-view="B"] [data-blume-view]:not([data-blume-view="B"]){display:none!important}'
    );
    expect(viewStyle([])).toBe("");
  });

  it("keeps a title from breaking out of the string or the style element", () => {
    const style = viewStyle(['a"b\\c</style>\nd']);
    expect(style).toContain(String.raw`"a\"b\\c\3c /style> d"`);
    expect(style).not.toContain("</style>");
  });
});

/** Run the inline script against a fake page, returning what it set. */
const runInit = (options: {
  closest?: boolean;
  search?: string;
  stored?: string | null;
  storageThrows?: boolean;
  views?: string | null;
  withSelect?: boolean;
}) => {
  const set: Record<string, string> = {};
  const select = { value: "" };
  const switcher = {
    getAttribute: () => options.views ?? null,
    querySelector: () => (options.withSelect === false ? null : select),
  };
  const document = {
    body: {
      setAttribute: (name: string, value: string) => {
        set[name] = value;
      },
    },
    currentScript: {
      closest: () => (options.closest === false ? null : switcher),
    },
  };
  const localStorage = {
    getItem: () => {
      if (options.storageThrows) {
        throw new Error("blocked");
      }
      return options.stored ?? null;
    },
  };
  const location = { search: options.search ?? "" };
  // oxlint-disable-next-line no-new-func -- runs the inline script as the page would
  new Function("document", "localStorage", "location", VIEW_INIT_SCRIPT)(
    document,
    localStorage,
    location
  );
  return { body: set["data-blume-view"], select: select.value };
};

describe("the view init script", () => {
  const views = '["JavaScript","Python"]';

  it("applies a linked view over the reader's last pick, before paint", () => {
    expect(
      runInit({ search: "?view=Python", stored: "JavaScript", views })
    ).toStrictEqual({ body: "Python", select: "Python" });
    expect(runInit({ stored: "Python", views })).toStrictEqual({
      body: "Python",
      select: "Python",
    });
  });

  it("falls back to the first view when storage is off or the pick is gone", () => {
    expect(runInit({ storageThrows: true, views })).toStrictEqual({
      body: "JavaScript",
      select: "JavaScript",
    });
    expect(runInit({ stored: "Go", views, withSelect: false })).toStrictEqual({
      body: "JavaScript",
      select: "",
    });
  });

  it("does nothing outside a picker, or with no views", () => {
    expect(runInit({ closest: false, views })).toStrictEqual({
      body: undefined,
      select: "",
    });
    expect(runInit({ views: "not json" })).toStrictEqual({
      body: undefined,
      select: "",
    });
    expect(runInit({ views: null })).toStrictEqual({
      body: undefined,
      select: "",
    });
  });
});

describe("View in the agent Markdown", () => {
  it("labels each view's content with its name", () => {
    expect(
      downlevelComponents(
        '<View title="Python">\n\nRun it.\n\n</View>\n\n<View title="Go" />\n\n<View>\n\nUntitled.\n\n</View>\n'
      )
    ).toBe("**Python**\n\nRun it.\n\n**Go**\n\nUntitled.\n");
  });
});

describe("the page template", () => {
  it("renders the picker above the content when the page has views", () => {
    const template = catchAllPageTemplate({
      exportEpub: false,
      exportPdf: false,
      mathEnabled: false,
      needsReact: false,
    });
    expect(template).toContain(`remarkPluginFrontmatter?.${VIEWS_KEY}`);
    expect(template).toContain(
      "{views.length > 1 && <ViewSwitcher label={ui.content.selectView} views={views} />}"
    );
    expect(template).toContain("  View,\n");
  });
});
