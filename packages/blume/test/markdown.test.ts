import { describe, expect, it } from "bun:test";

import { codeTitleTransformer } from "../src/markdown/code-title.ts";
import {
  calloutTypeFor,
  directiveToCalloutPlugin,
} from "../src/markdown/directives.ts";
import { headingAnchorPlugin } from "../src/markdown/heading-anchors.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
  blumeShikiTransformers,
  highlightCode,
} from "../src/markdown/index.ts";
import {
  inlineCodeHighlightPlugin,
  parseInlineLang,
} from "../src/markdown/inline-code.ts";
import { languageIconTransformer } from "../src/markdown/language-icon.ts";
import { mathPlugin } from "../src/markdown/math.ts";
import {
  codeBlock,
  jsxAttribute,
  jsxFlowElement,
  jsxTextElement,
} from "../src/markdown/mdast.ts";
import { mermaidPlugin } from "../src/markdown/mermaid.ts";
import {
  PACKAGE_MANAGERS,
  toPackageCommands,
} from "../src/markdown/package-commands.ts";
import { packageInstallPlugin } from "../src/markdown/package-install.ts";

/** Run a plugin visitor and capture the node it replaces, if any. */
const captureReplacement = (
  run: (ctx: {
    replaceNode: (node: unknown, replacement: unknown) => void;
  }) => void
): unknown => {
  let replacement: unknown;
  run({
    replaceNode: (_node, value) => {
      replacement = value;
    },
  });
  return replacement;
};

/** Run the code-meta transformer over a fence's meta and return the <pre> attrs. */
const metaAttrs = (
  raw?: string
): Record<string, boolean | number | string | undefined> => {
  const node = {
    properties: {} as Record<string, boolean | number | string | undefined>,
  };
  codeTitleTransformer().pre.call({ options: { meta: { __raw: raw } } }, node);
  return node.properties;
};

describe(calloutTypeFor, () => {
  it("passes through canonical callout types", () => {
    expect(calloutTypeFor("note")).toBe("note");
    expect(calloutTypeFor("warning")).toBe("warning");
    expect(calloutTypeFor("tip")).toBe("tip");
  });

  it("resolves aliases", () => {
    expect(calloutTypeFor("caution")).toBe("warning");
    expect(calloutTypeFor("error")).toBe("danger");
    expect(calloutTypeFor("important")).toBe("note");
  });

  it("is case-insensitive", () => {
    expect(calloutTypeFor("NOTE")).toBe("note");
  });

  it("returns null for non-callout directives", () => {
    expect(calloutTypeFor("details")).toBeNull();
  });
});

describe(toPackageCommands, () => {
  it("treats a bare package list as an install", () => {
    expect(toPackageCommands("react react-dom")).toStrictEqual({
      bun: "bun add react react-dom",
      npm: "npm install react react-dom",
      pnpm: "pnpm add react react-dom",
      yarn: "yarn add react react-dom",
    });
  });

  it("converts an explicit npm install with a dev flag", () => {
    expect(toPackageCommands("npm i -D typescript")).toStrictEqual({
      bun: "bun add -D typescript",
      npm: "npm install -D typescript",
      pnpm: "pnpm add -D typescript",
      yarn: "yarn add -D typescript",
    });
  });

  it("normalizes --save-dev to -D", () => {
    expect(toPackageCommands("npm install --save-dev vitest").pnpm).toBe(
      "pnpm add -D vitest"
    );
  });

  it("handles a bare `npm install` as install-all", () => {
    expect(toPackageCommands("npm install")).toStrictEqual({
      bun: "bun install",
      npm: "npm install",
      pnpm: "pnpm install",
      yarn: "yarn install",
    });
  });

  it("maps yarn's global form onto every manager's global install", () => {
    expect(toPackageCommands("yarn global add typescript")).toStrictEqual({
      bun: "bun add typescript -g",
      npm: "npm install typescript -g",
      pnpm: "pnpm add typescript -g",
      yarn: "yarn global add typescript",
    });
    expect(toPackageCommands("yarn global remove typescript").yarn).toBe(
      "yarn global remove typescript"
    );
  });

  it("maps npx to each manager's exec command", () => {
    expect(toPackageCommands("npx astro add react")).toStrictEqual({
      bun: "bunx astro add react",
      npm: "npx astro add react",
      pnpm: "pnpm dlx astro add react",
      yarn: "yarn dlx astro add react",
    });
  });

  it("maps create/init", () => {
    expect(toPackageCommands("npm create astro@latest")).toStrictEqual({
      bun: "bun create astro@latest",
      npm: "npm create astro@latest",
      pnpm: "pnpm create astro@latest",
      yarn: "yarn create astro@latest",
    });
  });

  it("routes global installs through yarn global add", () => {
    expect(toPackageCommands("npm i -g vercel")).toStrictEqual({
      bun: "bun add -g vercel",
      npm: "npm install -g vercel",
      pnpm: "pnpm add -g vercel",
      yarn: "yarn global add vercel",
    });
  });

  it("maps uninstall to remove", () => {
    expect(toPackageCommands("npm uninstall lodash")).toStrictEqual({
      bun: "bun remove lodash",
      npm: "npm uninstall lodash",
      pnpm: "pnpm remove lodash",
      yarn: "yarn remove lodash",
    });
  });

  it("keeps run scripts on each manager", () => {
    expect(toPackageCommands("npm run build").yarn).toBe("yarn run build");
  });

  it("routes a global uninstall through yarn global remove", () => {
    expect(toPackageCommands("npm uninstall -g eslint")).toStrictEqual({
      bun: "bun remove -g eslint",
      npm: "npm uninstall -g eslint",
      pnpm: "pnpm remove -g eslint",
      yarn: "yarn global remove eslint",
    });
  });

  it("maps npm ci to a frozen install per manager", () => {
    // Yarn gets Berry's `--immutable` (`--frozen-lockfile` was removed in
    // Yarn 4), consistent with the Berry-only `yarn dlx` the exec case emits.
    expect(toPackageCommands("npm ci")).toStrictEqual({
      bun: "bun install --frozen-lockfile",
      npm: "npm ci",
      pnpm: "pnpm install --frozen-lockfile",
      yarn: "yarn install --immutable",
    });
  });
});

describe(codeTitleTransformer, () => {
  it("promotes the first bare token to a title", () => {
    expect(metaAttrs("blume.config.ts").dataTitle).toBe("blume.config.ts");
  });

  it("reads an explicit title attribute", () => {
    expect(metaAttrs('title="My File"').dataTitle).toBe("My File");
  });

  it("allows the other quote character inside a quoted title", () => {
    // `title="foo's file.ts"` used to fail the match, and the bare-token
    // fallback then promoted the mangled `file.ts"` fragment instead.
    expect(metaAttrs(`title="foo's file.ts"`).dataTitle).toBe("foo's file.ts");
    expect(metaAttrs(`title='say "hi".ts'`).dataTitle).toBe('say "hi".ts');
  });

  it("sets data-line-numbers and keeps the title", () => {
    const attrs = metaAttrs("file.ts lineNumbers");
    expect(attrs.dataTitle).toBe("file.ts");
    expect(attrs.dataLineNumbers).toBeTruthy();
  });

  it("does not treat the lineNumbers keyword as a title", () => {
    const attrs = metaAttrs("lineNumbers");
    expect(attrs.dataTitle).toBeUndefined();
    expect(attrs.dataLineNumbers).toBeTruthy();
  });

  it("does not treat the twoslash keyword as a title", () => {
    expect(metaAttrs("twoslash").dataTitle).toBeUndefined();
  });

  it("ignores line ranges and leaves plain blocks bare", () => {
    expect(metaAttrs("{1,3-5}").dataTitle).toBeUndefined();
    expect(metaAttrs().dataLineNumbers).toBeUndefined();
  });

  it("does not read another attribute's *title= suffix as the title", () => {
    // `subtitle="Setup"` used to match `title=` with no left boundary.
    expect(metaAttrs('subtitle="Setup"').dataTitle).toBeUndefined();
    expect(metaAttrs('subtitle="Setup" title="Real"').dataTitle).toBe("Real");
  });

  it("does not enable line numbers from a word inside a quoted value", () => {
    const attrs = metaAttrs('title="enable lineNumbers later"');
    expect(attrs.dataTitle).toBe("enable lineNumbers later");
    expect(attrs.dataLineNumbers).toBeUndefined();
  });
});

describe(blumeShikiTransformers, () => {
  it("enables the notation, range, icon, and meta transformers by default", () => {
    const names = blumeShikiTransformers().map(
      (transformer) => transformer.name ?? ""
    );
    expect(names).toHaveLength(7);
    // Upstream Shiki transformers (notation + meta-highlight range) run first.
    expect(names).toContain("@shikijs/transformers:notation-highlight");
    expect(names).toContain("@shikijs/transformers:notation-diff");
    expect(names).toContain("@shikijs/transformers:notation-highlight-word");
    expect(names).toContain("@shikijs/transformers:notation-focus");
    expect(names).toContain("@shikijs/transformers:meta-highlight");
    // Blume's own transformers: the icon, then the fence-meta reader last.
    expect(names).toContain("blume:language-icon");
    expect(names.at(-1)).toBe("blume:code-meta");
  });

  it("drops the icon transformer when icons are disabled", () => {
    const names = blumeShikiTransformers({ icons: false }).map(
      (transformer) => transformer.name ?? ""
    );
    expect(names).toHaveLength(6);
    expect(names).not.toContain("blume:language-icon");
    expect(names.at(-1)).toBe("blume:code-meta");
  });
});

describe(parseInlineLang, () => {
  it("splits a trailing marker from the code", () => {
    expect(parseInlineLang("useState(){:js}")).toStrictEqual({
      code: "useState()",
      lang: "js",
    });
  });

  it("ignores plain code and marker-only or non-language markers", () => {
    expect(parseInlineLang("useState()")).toBeNull();
    expect(parseInlineLang("{:js}")).toBeNull();
    expect(parseInlineLang("x{:.keyword}")).toBeNull();
  });
});

describe(languageIconTransformer, () => {
  type IconPreNode = Parameters<
    ReturnType<typeof languageIconTransformer>["pre"]
  >[0];

  /** Run the icon transformer over a language and return the <pre> node. */
  const runIcon = (lang?: string): IconPreNode => {
    const node = { children: [], properties: {} } as unknown as IconPreNode;
    languageIconTransformer().pre.call({ options: { lang } }, node);
    return node;
  };

  it("prepends an icon and marks the block for known languages", () => {
    const node = runIcon("ts");
    expect(node.properties.dataIcon).toBe("");
    expect(node.children).toHaveLength(1);
    expect(node.children[0]?.properties?.className).toStrictEqual([
      "blume-lang-icon",
    ]);
  });

  it("is case-insensitive and resolves aliases", () => {
    expect(runIcon("TSX").properties.dataIcon).toBe("");
    expect(runIcon("shell").children).toHaveLength(1);
  });

  it("leaves unknown languages untouched", () => {
    const node = runIcon("plaintext");
    expect(node.properties.dataIcon).toBeUndefined();
    expect(node.children).toHaveLength(0);
  });
});

describe("mdast builders", () => {
  it("renders a value-less attribute as a boolean attribute", () => {
    expect(jsxAttribute("open")).toStrictEqual({
      name: "open",
      type: "mdxJsxAttribute",
      value: null,
    });
  });

  it("carries a string value when given one", () => {
    expect(jsxAttribute("title", "Hi").value).toBe("Hi");
  });

  it("builds flow and text JSX elements, defaulting text children to []", () => {
    const attr = jsxAttribute("type", "note");
    expect(jsxFlowElement("Callout", [attr], ["body"])).toStrictEqual({
      attributes: [attr],
      children: ["body"],
      name: "Callout",
      type: "mdxJsxFlowElement",
    });
    expect(jsxTextElement("Math", [attr])).toStrictEqual({
      attributes: [attr],
      children: [],
      name: "Math",
      type: "mdxJsxTextElement",
    });
  });

  it("builds a fenced code block with a null meta", () => {
    expect(codeBlock("bash", "npm i")).toStrictEqual({
      lang: "bash",
      meta: null,
      type: "code",
      value: "npm i",
    });
  });
});

describe("directiveToCalloutPlugin", () => {
  const body = {
    children: [{ type: "text", value: "Body" }],
    type: "paragraph",
  };

  it("rewrites a known directive into a typed <Callout>", () => {
    const node = { children: [body], name: "tip", type: "containerDirective" };
    const result = captureReplacement((ctx) =>
      directiveToCalloutPlugin().containerDirective(node, ctx)
    );
    expect(result).toStrictEqual(
      jsxFlowElement("Callout", [jsxAttribute("type", "tip")], [body])
    );
  });

  it("uses a {title} attribute for the callout title", () => {
    const node = {
      attributes: { title: "Heads up" },
      children: [body],
      name: "warning",
      type: "containerDirective",
    };
    const result = captureReplacement((ctx) =>
      directiveToCalloutPlugin().containerDirective(node, ctx)
    );
    expect(result).toStrictEqual(
      jsxFlowElement(
        "Callout",
        [jsxAttribute("type", "warning"), jsxAttribute("title", "Heads up")],
        [body]
      )
    );
  });

  it("lifts a [label] paragraph into the title and drops it from the body", () => {
    const label = {
      children: [{ type: "text", value: "My Label" }],
      data: { directiveLabel: true },
      type: "paragraph",
    };
    const node = {
      children: [label, body],
      name: "note",
      type: "containerDirective",
    };
    const result = captureReplacement((ctx) =>
      directiveToCalloutPlugin().containerDirective(node, ctx)
    );
    expect(result).toStrictEqual(
      jsxFlowElement(
        "Callout",
        [jsxAttribute("type", "note"), jsxAttribute("title", "My Label")],
        [body]
      )
    );
  });

  it("keeps formatted words in a [label] title", () => {
    const label = {
      children: [
        { type: "text", value: "Read " },
        { children: [{ type: "text", value: "this" }], type: "strong" },
        { type: "text", value: " now" },
      ],
      data: { directiveLabel: true },
      type: "paragraph",
    };
    const node = {
      children: [label, body],
      name: "note",
      type: "containerDirective",
    };
    const result = captureReplacement((ctx) =>
      directiveToCalloutPlugin().containerDirective(node, ctx)
    ) as { attributes: { name: string; value: string }[] };
    const title = result.attributes.find((a) => a.name === "title");
    expect(title?.value).toBe("Read this now");
  });

  it("leaves a non-callout directive untouched", () => {
    const node = {
      children: [body],
      name: "figure",
      type: "containerDirective",
    };
    const result = captureReplacement((ctx) =>
      directiveToCalloutPlugin().containerDirective(node, ctx)
    );
    expect(result).toBeUndefined();
  });

  it("handles an empty directive (`children: null`) without throwing", () => {
    // Satteri parses an empty `:::note\n:::` to a node with `children: null`.
    const node = { children: null, name: "note", type: "containerDirective" };
    const result = captureReplacement((ctx) =>
      directiveToCalloutPlugin().containerDirective(node, ctx)
    );
    expect(result).toStrictEqual(
      jsxFlowElement("Callout", [jsxAttribute("type", "note")], [])
    );
  });
});

describe("packageInstallPlugin", () => {
  it("expands a package-install block into one tab per manager", () => {
    const node = { lang: "package-install", type: "code", value: "react" };
    const result = captureReplacement((ctx) =>
      packageInstallPlugin().code(node, ctx)
    );
    const commands = toPackageCommands("react");
    expect(result).toStrictEqual(
      jsxFlowElement(
        "Tabs",
        // hash off so switching package managers can't clobber the page hash.
        [jsxAttribute("hash", "false")],
        PACKAGE_MANAGERS.map((manager) =>
          jsxFlowElement(
            "Tab",
            [jsxAttribute("title", manager)],
            [codeBlock("bash", commands[manager])]
          )
        )
      )
    );
  });

  it("ignores code blocks in other languages", () => {
    const node = { lang: "ts", type: "code", value: "const x = 1;" };
    const result = captureReplacement((ctx) =>
      packageInstallPlugin().code(node, ctx)
    );
    expect(result).toBeUndefined();
  });
});

describe("mathPlugin", () => {
  it("rewrites block math into a display <Math> element", () => {
    const node = { type: "math", value: "a^2 + b^2" };
    const result = captureReplacement((ctx) => mathPlugin().math(node, ctx));
    expect(result).toStrictEqual(
      jsxFlowElement(
        "Math",
        [jsxAttribute("code", "a^2 + b^2"), jsxAttribute("display")],
        []
      )
    );
  });

  it("rewrites inline math into an inline <Math> element", () => {
    const node = { type: "inlineMath", value: "x_i" };
    const result = captureReplacement((ctx) =>
      mathPlugin().inlineMath(node, ctx)
    );
    expect(result).toStrictEqual(
      jsxTextElement("Math", [jsxAttribute("code", "x_i")])
    );
  });
});

/** Recursively read a node's text, like Satteri's `textContent`. */
const textOf = (node: { children?: unknown[]; value?: unknown }): string =>
  typeof node.value === "string"
    ? node.value
    : (node.children ?? [])
        .map((child) => textOf(child as { value?: unknown }))
        .join("");

describe("headingAnchorPlugin", () => {
  interface HeadingNode {
    children: { type: string; value?: string }[];
    properties: Record<string, unknown>;
    tagName: string;
    type: string;
  }

  /** A hast context whose `setProperty` mutates the node so tests can assert. */
  const makeCtx = () => ({
    data: { astro: { frontmatter: {} } },
    setProperty(
      node: { properties?: Record<string, unknown> },
      key: string,
      value: unknown
    ) {
      node.properties = { ...node.properties, [key]: value };
    },
    textContent: textOf,
  });

  /** A heading node with text (or element) children. */
  const heading = (tagName: string, ...children: unknown[]): HeadingNode => ({
    children: children.map((child) =>
      typeof child === "string" ? { type: "text", value: child } : child
    ) as HeadingNode["children"],
    properties: {},
    tagName,
    type: "element",
  });

  it("wraps an h2's content in an anchor to its own slug", () => {
    const node = heading("h2", "Getting Started");
    const result = headingAnchorPlugin().element.visit(node, makeCtx());
    expect(result).toStrictEqual({
      children: [
        {
          children: node.children,
          properties: {
            className: ["blume-heading-anchor"],
            href: "#getting-started",
          },
          tagName: "a",
          type: "element",
        },
      ],
      properties: { id: "getting-started" },
      tagName: "h2",
      type: "element",
    });
  });

  it("slugs an h1 for id parity but leaves it unwrapped", () => {
    const node = heading("h1", "Title");
    const result = headingAnchorPlugin().element.visit(node, makeCtx());
    expect(result).toBeUndefined();
    expect(node.properties.id).toBe("title");
  });

  it("disambiguates duplicate headings within one render", () => {
    const plugin = headingAnchorPlugin();
    const ctx = makeCtx();
    const first = plugin.element.visit(heading("h2", "Setup"), ctx);
    const second = plugin.element.visit(heading("h2", "Setup"), ctx);
    expect(first?.properties?.id).toBe("setup");
    expect(first?.children?.[0]?.properties?.href).toBe("#setup");
    expect(second?.properties?.id).toBe("setup-1");
    expect(second?.children?.[0]?.properties?.href).toBe("#setup-1");
  });

  it("resets disambiguation across renders", () => {
    const plugin = headingAnchorPlugin();
    const a = plugin.element.visit(heading("h2", "Setup"), makeCtx());
    const b = plugin.element.visit(heading("h2", "Setup"), makeCtx());
    expect(a?.properties?.id).toBe("setup");
    expect(b?.properties?.id).toBe("setup");
  });

  it("skips wrapping a heading that already contains a link", () => {
    const link = {
      children: [{ type: "text", value: "docs" }],
      properties: { href: "https://example.com" },
      tagName: "a",
      type: "element",
    };
    const node = heading("h3", link);
    const result = headingAnchorPlugin().element.visit(node, makeCtx());
    expect(result).toBeUndefined();
    expect(node.properties.id).toBe("docs");
  });

  it("reuses an author-supplied id for both the heading and the link", () => {
    const node = { ...heading("h2", "Custom"), properties: { id: "my-id" } };
    const result = headingAnchorPlugin().element.visit(node, makeCtx());
    expect(result?.properties?.id).toBe("my-id");
    expect(result?.children?.[0]?.properties?.href).toBe("#my-id");
  });
});

describe("mermaidPlugin", () => {
  it("rewrites a mermaid fence into a <blume-mermaid> element", () => {
    const node = { lang: "mermaid", type: "code", value: "graph TD; A-->B;" };
    const result = captureReplacement((ctx) => mermaidPlugin().code(node, ctx));
    expect(result).toStrictEqual(
      jsxFlowElement(
        "blume-mermaid",
        [
          jsxAttribute(
            "class",
            "not-prose my-6 flex justify-center overflow-x-auto"
          ),
          jsxAttribute("data-source", "graph TD; A-->B;"),
        ],
        []
      )
    );
  });

  it("ignores non-mermaid code blocks", () => {
    const node = { lang: "js", type: "code", value: "1" };
    const result = captureReplacement((ctx) => mermaidPlugin().code(node, ctx));
    expect(result).toBeUndefined();
  });
});

/** A hast context reporting a parent tag (or none) and the node's own text. */
const inlineCtx = (parentTag: string | undefined, text: string) => ({
  parent: () => (parentTag === undefined ? undefined : { tagName: parentTag }),
  textContent: () => text,
});

describe("inlineCodeHighlightPlugin", () => {
  const plugin = inlineCodeHighlightPlugin();
  const { visit } = plugin.element;

  it("is named and filters to <code> elements", () => {
    expect(plugin.name).toBe("blume:inline-code");
    expect(plugin.element.filter).toStrictEqual(["code"]);
  });

  it("skips a <code> nested in a <pre> (a fenced block)", async () => {
    const result = await visit(
      { type: "element" },
      inlineCtx("pre", "const x = 1{:ts}")
    );
    expect(result).toBeUndefined();
  });

  it("highlights inline code carrying a {:lang} marker", async () => {
    const result = await visit(
      { type: "element" },
      inlineCtx(undefined, "useState(){:ts}")
    );
    expect(result?.tagName).toBe("code");
    expect(result?.properties?.className).toStrictEqual(["blume-inline-code"]);
    expect(result?.children?.length).toBeGreaterThan(0);
  });

  it("leaves inline code without a marker untouched", async () => {
    const result = await visit(
      { type: "element" },
      inlineCtx(undefined, "useState()")
    );
    expect(result).toBeUndefined();
  });

  it("strips the marker and falls back to plain code for an unknown language", async () => {
    // A typo'd language must not leak the literal `{:lang}` marker into the
    // rendered page: the marker is stripped and the code stays unhighlighted.
    const result = await visit(
      { tagName: "code", type: "element" },
      inlineCtx(undefined, "x{:notalang}")
    );
    expect(result?.tagName).toBe("code");
    expect(result?.children).toStrictEqual([{ type: "text", value: "x" }]);
    expect(result?.properties).toBeUndefined();
  });
});

/** Build a processor's renderer and return the HTML for a source string. */
const renderTo = async (
  processor: ReturnType<typeof blumeMarkdownProcessor>,
  source: string
): Promise<string> => {
  const renderer = await processor.createRenderer({});
  const result = await renderer.render(source);
  return result.code;
};

describe("markdown processors", () => {
  it("wires always-on inline highlighting and heading anchors for .md", async () => {
    const html = await renderTo(
      blumeMarkdownProcessor({}),
      "## Title\n\n`x{:ts}`"
    );
    expect(html).toContain("blume-inline-code");
    expect(html).toContain("blume-heading-anchor");
  });

  it("keeps inline highlighting but drops anchors when anchors are off", async () => {
    const html = await renderTo(
      blumeMarkdownProcessor({ headingAnchors: false }),
      "## Title\n\n`x{:ts}`"
    );
    // Inline highlighting only fires on the `{:lang}` marker, so it's always on.
    expect(html).toContain("blume-inline-code");
    expect(html).not.toContain("blume-heading-anchor");
    // The id still lands so the TOC and in-page links resolve.
    expect(html).toContain('id="title"');
  });

  it("parses block math in .mdx but leaves single-dollar prose literal", async () => {
    // `$$…$$` is consumed into the `<Math>` component: the delimiters vanish
    // while the surrounding prose renders normally.
    const block = await renderTo(
      blumeMdxProcessor({}),
      "Before\n\n$$\na^2\n$$\n\nAfter"
    );
    expect(block).toContain("Before");
    expect(block).toContain("After");
    expect(block).not.toContain("$$");

    // A bare `$` (currency, shell, code) stays literal — block-only math.
    const prose = await renderTo(blumeMdxProcessor({}), "It costs $5 to $10.");
    expect(prose).toContain("$5 to $10");
  });

  it("renders .mdx through the shared always-on inline + anchor feature set", async () => {
    const html = await renderTo(
      blumeMdxProcessor({}),
      "`y{:js}`\n\n## Heading"
    );
    expect(html).toContain("blume-inline-code");
    expect(html).toContain("blume-heading-anchor");
  });
});

describe("toPackageCommands (verb and flag normalization)", () => {
  it("recognizes every add alias", () => {
    for (const verb of ["add", "i", "in", "install"]) {
      expect(toPackageCommands(`pnpm ${verb} react`).npm).toBe(
        "npm install react"
      );
    }
  });

  it("recognizes init alongside create", () => {
    expect(toPackageCommands("pnpm init").pnpm).toBe("pnpm create");
  });

  it("maps every exec alias to each manager's runner", () => {
    expect(toPackageCommands("pnpm exec astro").pnpm).toBe("pnpm dlx astro");
    expect(toPackageCommands("pnpm dlx astro").yarn).toBe("yarn dlx astro");
    expect(toPackageCommands("bun x astro").bun).toBe("bunx astro");
  });

  it("recognizes every remove alias", () => {
    for (const verb of ["remove", "rm", "un", "uninstall"]) {
      expect(toPackageCommands(`pnpm ${verb} lodash`).pnpm).toBe(
        "pnpm remove lodash"
      );
    }
  });

  it("runs an unknown subcommand as a script", () => {
    expect(toPackageCommands("npm test").yarn).toBe("yarn run test");
  });

  it("strips redundant --save / -S flags", () => {
    expect(toPackageCommands("npm install --save react").pnpm).toBe(
      "pnpm add react"
    );
    expect(toPackageCommands("npm install -S react").pnpm).toBe(
      "pnpm add react"
    );
  });

  it("treats blank input and a bare manager as install-all", () => {
    expect(toPackageCommands("   ").npm).toBe("npm install");
    expect(toPackageCommands("npm").npm).toBe("npm install");
  });
});

describe("highlightCode", () => {
  it("tags the highlighted block with the astro-code class", async () => {
    const html = await highlightCode("const x = 1;", "ts");
    expect(html).toContain("astro-code");
    expect(html).toContain("const");
  });

  it("emits a data-language and title header on the titled path", async () => {
    const html = await highlightCode("const x = 1;", "ts", {
      title: "file.ts",
    });
    expect(html).toContain('data-language="ts"');
    expect(html).toContain('data-title="file.ts"');
  });

  it("omits data-language on the header-less path so the icon gate hides it", async () => {
    // The icon transformer still runs (data-icon is set), but without a title
    // there's no header bar (data-language), so the theme's `pre[data-language]
    // [data-icon]` gate keeps the absolutely-positioned icon from overlapping
    // the first code line. See https://github.com/haydenbleasel/blume/issues/56
    const html = await highlightCode("const x = 1;", "ts");
    expect(html).not.toContain("data-language");
    expect(html).toContain("data-icon");
    expect(html).toContain("blume-lang-icon");
  });

  it("applies an extra className to the <pre>", async () => {
    const html = await highlightCode("const x = 1;", "ts", {
      className: "blume-source",
    });
    expect(html).toContain("blume-source");
    expect(html).toContain("astro-code");
  });

  it("falls back to an escaped plain block for an unknown language", async () => {
    const html = await highlightCode("<a> & </a>", "this-is-not-a-lang", {
      className: "blume-source",
    });
    expect(html).toContain('<pre class="astro-code blume-source">');
    // The raw input is HTML-escaped so it renders as text, not markup.
    expect(html).toContain("&lt;a&gt; &amp; &lt;/a&gt;");
    expect(html).not.toContain("<a>");
  });

  it("honors a custom themes option (differs from the default pair)", async () => {
    const code = "const x = 1;";
    const [byDefault, custom] = await Promise.all([
      highlightCode(code, "ts"),
      highlightCode(code, "ts", {
        themes: { dark: "vesper", light: "github-light" },
      }),
    ]);
    // Theme names never appear in Shiki's dual-theme output (only the resolved
    // colors do), so a different dark theme must change the emitted markup.
    expect(custom).not.toBe(byDefault);
  });
});

describe("headingAnchorPlugin (frontmatter interpolation)", () => {
  it("resolves a frontmatter expression via Satteri's collector", () => {
    const node = {
      children: [{ type: "mdxTextExpression", value: "frontmatter.title" }],
      properties: {},
      tagName: "h2",
      type: "element",
    };
    const ctx = {
      data: { astro: { frontmatter: { title: "Real Title" } } },
      setProperty(
        target: { properties?: Record<string, unknown> },
        key: string,
        value: unknown
      ) {
        target.properties = { ...target.properties, [key]: value };
      },
      textContent: textOf,
    };
    const result = headingAnchorPlugin().element.visit(node, ctx);
    expect(result?.properties?.id).toBe("real-title");
    expect(result?.children?.[0]?.properties?.href).toBe("#real-title");
  });
});
