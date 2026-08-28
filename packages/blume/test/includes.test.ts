import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { dirname, join } from "pathe";

import { buildRawMarkdown } from "../src/ai/markdown.ts";
import { includeHmrPlugin } from "../src/astro/include-hmr.ts";
import {
  advanceHtmlCommentState,
  buildIncludeGraph,
  expandIncludes,
  expandIncludeTarget,
  hasIncludeStatements,
  parseIncludeLine,
  parseIncludeStatement,
} from "../src/core/includes.ts";
import { validateLinks } from "../src/core/links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import {
  extractHeadings,
  normalizeEntry,
} from "../src/core/sources/normalize.ts";
import { readExpandedEntryText } from "../src/core/sources/read.ts";
import type { ContentSource } from "../src/core/sources/types.ts";
import type { PageRecord } from "../src/core/types.ts";
import { includePlugin } from "../src/markdown/include.ts";
import { blumeMarkdownProcessor } from "../src/markdown/index.ts";
import type { MdastNode } from "../src/markdown/mdast.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-includes-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

describe("hasIncludeStatements", () => {
  it("pre-filters on the opening tag", () => {
    expect(hasIncludeStatements("<include>./x.md</include>")).toBe(true);
    expect(hasIncludeStatements("plain text")).toBe(false);
  });
});

describe("parseIncludeStatement", () => {
  it("parses a bare statement", () => {
    expect(parseIncludeStatement("<include>./a.mdx</include>")).toEqual({
      attributes: {},
      target: "./a.mdx",
    });
  });

  it("parses lang and meta in either quote style", () => {
    expect(
      parseIncludeStatement(
        `<include lang="ts" meta='title="x.ts"'>./x.ts</include>`
      )
    ).toEqual({
      attributes: { lang: "ts", meta: 'title="x.ts"' },
      target: "./x.ts",
    });
  });

  it("tolerates bare and unknown attributes", () => {
    expect(
      parseIncludeStatement('<include cwd other="1">./a.md</include>')
    ).toEqual({ attributes: {}, target: "./a.md" });
  });

  it("trims whitespace around the target and close tag", () => {
    expect(parseIncludeStatement("<include> ./a.md </include >")).toEqual({
      attributes: {},
      target: "./a.md",
    });
  });

  it("rejects prose, inline usage, and empty targets", () => {
    expect(parseIncludeStatement("use <include> to embed")).toBeNull();
    expect(parseIncludeStatement("<include></include>")).toBeNull();
    expect(parseIncludeStatement("plain line")).toBeNull();
  });

  it("rejects an unclosed statement with a long space run in linear time", () => {
    // The target's ends are pinned to non-space characters so the trailing
    // run is consumed by one `\s*` alone — a lazy target overlapping it
    // backtracked quadratically here (CodeQL js/polynomial-redos), taking
    // seconds at this length; the suite would hang rather than pass.
    expect(
      parseIncludeStatement(`<include>!${" ".repeat(100_000)}`)
    ).toBeNull();
  });
});

describe("expandIncludes", () => {
  it("splices a partial with its front matter stripped", async () => {
    const root = await fixture({
      "_snippets/shared.mdx": "---\ntitle: ignored\n---\n## Shared\n\nBody.\n",
      "page.mdx":
        "# Page\n\n<include>./_snippets/shared.mdx</include>\n\nAfter.\n",
    });
    const result = await expandIncludes(
      "# Page\n\n<include>./_snippets/shared.mdx</include>\n\nAfter.\n",
      { contentRoot: root, sourcePath: join(root, "page.mdx") }
    );
    expect(result.errors).toEqual([]);
    expect(result.text).toContain("## Shared");
    expect(result.text).not.toContain("title: ignored");
    expect(result.text).not.toContain("<include>");
    expect(result.includes).toEqual([join(root, "_snippets", "shared.mdx")]);
  });

  it("maps expanded lines back to their origin file and raw line", async () => {
    const root = await fixture({
      "_snippets/shared.mdx": "---\ntitle: t\n---\nShared line.\n",
      "page.mdx": "unused",
    });
    const body = "Intro.\n\n<include>./_snippets/shared.mdx</include>\n";
    const result = await expandIncludes(body, {
      contentRoot: root,
      lineOffset: 3,
      sourcePath: join(root, "page.mdx"),
    });
    const lines = result.text.split("\n");
    // The includer's own lines shift by the front matter offset.
    expect(result.origins[lines.indexOf("Intro.")]).toEqual({
      file: join(root, "page.mdx"),
      line: 4,
    });
    // The partial's line points at its own raw file line (after its FM).
    expect(result.origins[lines.indexOf("Shared line.")]).toEqual({
      file: join(root, "_snippets", "shared.mdx"),
      line: 4,
    });
  });

  it("pads blank lines only against non-blank neighbors", async () => {
    const root = await fixture({
      "page.md": "unused",
      "s.md": "spliced\n",
    });
    const padded = await expandIncludes(
      "before\n<include>./s.md</include>\nafter",
      { contentRoot: root, sourcePath: join(root, "page.md") }
    );
    expect(padded.text).toBe("before\n\nspliced\n\nafter");
    const unpadded = await expandIncludes(
      "before\n\n<include>./s.md</include>",
      { contentRoot: root, sourcePath: join(root, "page.md") }
    );
    expect(unpadded.text).toBe("before\n\nspliced");
  });

  it("leaves statements inside fenced code untouched", async () => {
    const root = await fixture({ "page.md": "unused" });
    const body = "```md\n<include>./x.md</include>\n```\n";
    const result = await expandIncludes(body, {
      contentRoot: root,
      sourcePath: join(root, "page.md"),
    });
    expect(result.text).toBe(body);
    expect(result.errors).toEqual([]);
  });

  it("expands nested includes and records them all", async () => {
    const root = await fixture({
      "a.mdx": "A top.\n\n<include>./nested/b.mdx</include>\n",
      "nested/b.mdx": "B body.\n",
      "page.mdx": "unused",
    });
    const result = await expandIncludes("<include>./a.mdx</include>\n", {
      contentRoot: root,
      sourcePath: join(root, "page.mdx"),
    });
    expect(result.text).toContain("A top.");
    expect(result.text).toContain("B body.");
    expect(result.includes.toSorted()).toEqual([
      join(root, "a.mdx"),
      join(root, "nested", "b.mdx"),
    ]);
  });

  it("reports a cycle and keeps the closing statement verbatim", async () => {
    const root = await fixture({
      "a.mdx": "<include>./b.mdx</include>\n",
      "b.mdx": "<include>./a.mdx</include>\n",
      "page.mdx": "unused",
    });
    const result = await expandIncludes("<include>./a.mdx</include>\n", {
      contentRoot: root,
      sourcePath: join(root, "page.mdx"),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("BLUME_INCLUDE_CYCLE");
    expect(result.errors[0]?.file).toBe(join(root, "b.mdx"));
    expect(result.text).toContain("<include>./a.mdx</include>");
  });

  it("reports a missing target at the statement's raw line", async () => {
    const root = await fixture({ "page.mdx": "unused" });
    const result = await expandIncludes("x\n<include>./gone.mdx</include>\n", {
      contentRoot: root,
      lineOffset: 2,
      sourcePath: join(root, "page.mdx"),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("BLUME_INCLUDE_NOT_FOUND");
    expect(result.errors[0]?.line).toBe(4);
    expect(result.text).toContain("<include>./gone.mdx</include>");
  });

  it("rejects targets that resolve outside the content root", async () => {
    const root = await fixture({ "docs/page.mdx": "unused" });
    const result = await expandIncludes("<include>../secret.md</include>\n", {
      contentRoot: join(root, "docs"),
      sourcePath: join(root, "docs", "page.mdx"),
    });
    expect(result.errors[0]?.code).toBe("BLUME_INCLUDE_OUTSIDE_ROOT");
  });

  it("resolves /-leading targets from the content root", async () => {
    const root = await fixture({
      "docs/deep/page.md": "unused",
      "shared/tip.md": "Root tip.\n",
    });
    const result = await expandIncludes("<include>/shared/tip.md</include>\n", {
      contentRoot: root,
      sourcePath: join(root, "docs", "deep", "page.md"),
    });
    expect(result.text).toContain("Root tip.");
  });

  it("skips containment when no content root is configured", async () => {
    const root = await fixture({
      "docs/page.md": "unused",
      "outside.md": "Outside body.\n",
    });
    const result = await expandIncludes("<include>../outside.md</include>\n", {
      sourcePath: join(root, "docs", "page.md"),
    });
    expect(result.text).toContain("Outside body.");
  });

  it("embeds a non-markdown target as a fenced code block", async () => {
    const root = await fixture({
      "example.ts": "const x = `a`;\n",
      "page.mdx": "unused",
    });
    const result = await expandIncludes(
      `<include meta='title="example.ts"'>./example.ts</include>\n`,
      { contentRoot: root, sourcePath: join(root, "page.mdx") }
    );
    expect(result.text).toContain(
      '```ts title="example.ts"\nconst x = `a`;\n```'
    );
  });

  it("extends the fence past the content's longest backtick run", async () => {
    const root = await fixture({
      "page.mdx": "unused",
      "sample.md": "````md\nnested\n````\n",
    });
    const result = await expandIncludes(
      '<include lang="md">./sample.md</include>\n',
      { contentRoot: root, sourcePath: join(root, "page.mdx") }
    );
    expect(result.text).toContain("`````md\n````md\nnested\n````\n`````");
  });

  it("falls back to a text fence for extension-less targets", async () => {
    const root = await fixture({ Procfile: "web: bun start\n", "p.md": "u" });
    const result = await expandIncludes("<include>./Procfile</include>\n", {
      contentRoot: root,
      sourcePath: join(root, "p.md"),
    });
    expect(result.text).toContain("```text\nweb: bun start\n```");
  });

  it("rebases a partial's relative images into the includer's directory", async () => {
    const root = await fixture({
      "_snippets/tip.mdx": [
        "![local](./diagram.png)",
        "![up](../assets/up.png)",
        "![abs](/public.png)",
        "![web](https://x.dev/i.png)",
        "`![code](./skip.png)`",
        "```",
        "![fenced](./skip.png)",
        "```",
        "",
      ].join("\n"),
      "page.mdx": "unused",
    });
    const result = await expandIncludes(
      "<include>./_snippets/tip.mdx</include>\n",
      { contentRoot: root, sourcePath: join(root, "page.mdx") }
    );
    expect(result.text).toContain("![local](./_snippets/diagram.png)");
    expect(result.text).toContain("![up](./assets/up.png)");
    expect(result.text).toContain("![abs](/public.png)");
    expect(result.text).toContain("![web](https://x.dev/i.png)");
    expect(result.text).toContain("`![code](./skip.png)`");
    expect(result.text).toContain("![fenced](./skip.png)");
  });

  it("trims blank edge lines off a splice", async () => {
    const root = await fixture({
      "gappy.md": "\n\nBody line.\n\n\n",
      "page.md": "unused",
    });
    const result = await expandIncludes("<include>./gappy.md</include>", {
      contentRoot: root,
      sourcePath: join(root, "page.md"),
    });
    expect(result.text).toBe("Body line.");
  });

  it("keeps image paths as written for a same-directory include", async () => {
    const root = await fixture({
      "page.md": "unused",
      "sib.md": "![pic](./pic.png)\n",
    });
    const result = await expandIncludes("<include>./sib.md</include>\n", {
      contentRoot: root,
      sourcePath: join(root, "page.md"),
    });
    expect(result.text).toContain("![pic](./pic.png)");
  });

  it("rejects a /-leading target that climbs above the content root", async () => {
    const root = await fixture({
      "docs/page.md": "unused",
      "outside.md": "Secret.\n",
    });
    const result = await expandIncludes("<include>/../outside.md</include>\n", {
      contentRoot: join(root, "docs"),
      sourcePath: join(root, "docs", "page.md"),
    });
    expect(result.errors[0]?.code).toBe("BLUME_INCLUDE_OUTSIDE_ROOT");
    expect(result.text).toContain("<include>/../outside.md</include>");
    expect(result.text).not.toContain("Secret.");
  });

  it("accepts an in-root directory whose name starts with two dots", async () => {
    const root = await fixture({
      "docs/..archive/x.md": "Archived.\n",
      "docs/page.md": "unused",
    });
    const result = await expandIncludes(
      "<include>./..archive/x.md</include>\n",
      {
        contentRoot: join(root, "docs"),
        sourcePath: join(root, "docs", "page.md"),
      }
    );
    expect(result.errors).toEqual([]);
    expect(result.text).toContain("Archived.");
  });

  it("skips statements inside a multi-line HTML comment in .md", async () => {
    const root = await fixture({ "page.md": "unused", "s.md": "Live.\n" });
    const body =
      "<!--\n<include>./s.md</include>\n-->\n\n<include>./s.md</include>\n";
    const result = await expandIncludes(body, {
      contentRoot: root,
      sourcePath: join(root, "page.md"),
    });
    // The commented statement stays verbatim; the live one after the close
    // still expands (comment state resumes correctly).
    expect(result.text).toContain("<!--\n<include>./s.md</include>\n-->");
    expect(result.text).toContain("Live.");
  });

  it("tracks several comment markers on one line", async () => {
    const root = await fixture({ "page.md": "unused", "s.md": "Live.\n" });
    const body =
      "<!-- a --><!--\n<include>./s.md</include>\n-->\n\n<include>./s.md</include>\n";
    const result = await expandIncludes(body, {
      contentRoot: root,
      sourcePath: join(root, "page.md"),
    });
    expect(result.text).toContain("\n<include>./s.md</include>\n-->");
    expect(result.text).toContain("Live.");
  });

  it("skips statements inside a JSX comment in .mdx", async () => {
    const root = await fixture({ "page.mdx": "unused", "s.mdx": "Live.\n" });
    const body = "{/*\n<include>./s.mdx</include>\n*/}\n";
    const result = await expandIncludes(body, {
      contentRoot: root,
      sourcePath: join(root, "page.mdx"),
    });
    expect(result.text).toBe(body);
    // An HTML comment is not a comment in .mdx, so the same body under a
    // `.md` source is what turns the skip on — the delimiters are per-format.
    const mdResult = await expandIncludes(
      "{/*\n<include>./s.mdx</include>\n*/}\n",
      { contentRoot: root, sourcePath: join(root, "page.md") }
    );
    expect(mdResult.text).toContain("Live.");
  });

  it("skips an indented-code statement in .md but not in .mdx", async () => {
    const root = await fixture({
      "page.md": "unused",
      "page.mdx": "unused",
      "s.md": "Spliced.\n",
    });
    const body = "Example:\n\n    <include>./s.md</include>\n";
    const mdResult = await expandIncludes(body, {
      contentRoot: root,
      sourcePath: join(root, "page.md"),
    });
    expect(mdResult.text).toBe(body);
    // MDX has no indented code blocks; the statement is still JSX flow there.
    const mdxResult = await expandIncludes(body, {
      contentRoot: root,
      sourcePath: join(root, "page.mdx"),
    });
    expect(mdxResult.text).toContain("Spliced.");
  });

  it("skips a .md statement a setext underline would fold into a heading", async () => {
    const root = await fixture({ "page.md": "unused", "s.md": "Spliced.\n" });
    const underlined = "<include>./s.md</include>\n---\n";
    const result = await expandIncludes(underlined, {
      contentRoot: root,
      sourcePath: join(root, "page.md"),
    });
    expect(result.text).toBe(underlined);
    // A blank line between them makes the `---` a thematic break again.
    const broken = await expandIncludes("<include>./s.md</include>\n\n---\n", {
      contentRoot: root,
      sourcePath: join(root, "page.md"),
    });
    expect(broken.text).toContain("Spliced.");
  });

  it("does not advance comment state on lines inside fenced code", async () => {
    const root = await fixture({ "page.md": "unused", "s.md": "Live.\n" });
    const result = await expandIncludes(
      "```html\n<!--\n```\n\n<include>./s.md</include>\n",
      { contentRoot: root, sourcePath: join(root, "page.md") }
    );
    expect(result.text).toContain("Live.");
  });
});

describe("parseIncludeLine", () => {
  it("parses an unindented statement and rejects code indentation", () => {
    expect(parseIncludeLine("  <include>./a.md</include>")).toEqual({
      attributes: {},
      target: "./a.md",
    });
    expect(parseIncludeLine("    <include>./a.md</include>")).toBeNull();
    expect(parseIncludeLine("\t<include>./a.md</include>")).toBeNull();
  });
});

describe("advanceHtmlCommentState", () => {
  it("toggles per marker, left to right", () => {
    expect(advanceHtmlCommentState("no markers", false)).toBe(false);
    expect(advanceHtmlCommentState("<!--", false)).toBe(true);
    expect(advanceHtmlCommentState("still inside", true)).toBe(true);
    expect(advanceHtmlCommentState("-->", true)).toBe(false);
    expect(advanceHtmlCommentState("<!-- x -->", false)).toBe(false);
  });
});

describe("buildIncludeGraph", () => {
  it("inverts page edges, deduping localized source paths", () => {
    expect(
      buildIncludeGraph([
        { includes: ["/p/_a.md"], sourcePath: "/p/one.md" },
        { includes: ["/p/_a.md"], sourcePath: "/p/one.md" },
        { includes: ["/p/_a.md", "/p/_b.md"], sourcePath: "/p/two.md" },
        { includes: ["/p/_a.md"] },
        { sourcePath: "/p/three.md" },
      ])
    ).toEqual({
      "/p/_a.md": ["/p/one.md", "/p/two.md"],
      "/p/_b.md": ["/p/two.md"],
    });
  });
});

describe("fence run-length awareness", () => {
  it("keeps a shorter inner run from closing a longer fence", () => {
    // The 4-backtick wrapper `codeBlockLines` emits: everything inside stays
    // fenced, so no phantom heading (or link/image mutation) escapes it.
    expect(
      extractHeadings("````md\n```\n# phantom\n```\n````\n# real")
    ).toEqual([{ depth: 1, slug: "real", text: "real" }]);
  });

  it("closes a fence on an equal or longer run of the same delimiter", () => {
    expect(extractHeadings("```\ncode\n`````\n# after")).toEqual([
      { depth: 1, slug: "after", text: "after" },
    ]);
  });
});

describe("expandIncludeTarget", () => {
  it("returns the spliced text for a resolvable statement", async () => {
    const root = await fixture({ "p.md": "u", "s.md": "Spliced.\n" });
    const result = await expandIncludeTarget(
      { attributes: {}, target: "./s.md" },
      { contentRoot: root, sourcePath: join(root, "p.md") }
    );
    expect(result).toEqual({ errors: [], text: "Spliced." });
  });

  it("returns the error for an unresolvable statement", async () => {
    const root = await fixture({ "p.md": "u" });
    const result = await expandIncludeTarget(
      { attributes: {}, target: "./gone.md" },
      { contentRoot: root, sourcePath: join(root, "p.md") }
    );
    expect("error" in result && result.error.code).toBe(
      "BLUME_INCLUDE_NOT_FOUND"
    );
  });

  it("errors on a /-leading target with no content root", async () => {
    const root = await fixture({ "p.md": "u" });
    const result = await expandIncludeTarget(
      { attributes: {}, target: "/s.md" },
      { sourcePath: join(root, "p.md") }
    );
    expect("error" in result && result.error.code).toBe(
      "BLUME_INCLUDE_OUTSIDE_ROOT"
    );
  });

  it("splices the outer partial and reports a broken nested include", async () => {
    const root = await fixture({
      "outer.md": "Outer.\n\n<include>./gone.md</include>\n",
      "p.md": "u",
    });
    const result = await expandIncludeTarget(
      { attributes: {}, target: "./outer.md" },
      { contentRoot: root, sourcePath: join(root, "p.md") }
    );
    if ("error" in result) {
      throw new Error("expected a splice");
    }
    expect(result.text).toContain("Outer.");
    expect(result.text).toContain("<include>./gone.md</include>");
    expect(result.errors[0]?.code).toBe("BLUME_INCLUDE_NOT_FOUND");
  });
});

/** A fake visitor context capturing replacements and reports. */
const fakeCtx = (options: {
  fileURL?: URL;
  source?: string;
  text?: string;
}) => {
  const replaced: { raw: string }[] = [];
  const reports: string[] = [];
  return {
    ctx: {
      fileURL: options.fileURL,
      replaceNode: (_node: MdastNode, replacement: { raw: string }) => {
        replaced.push(replacement);
      },
      report: (report: { message: string }) => {
        reports.push(report.message);
      },
      source: options.source ?? "",
      textContent: () => options.text ?? "",
    },
    replaced,
    reports,
  };
};

describe("includePlugin", () => {
  it("splices an mdx flow element with string attributes only", async () => {
    const root = await fixture({ "code.ts": "const a = 1;\n", "p.mdx": "u" });
    const { ctx, replaced } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.mdx")),
      text: " ./code.ts ",
    });
    const plugin = includePlugin({ contentRoot: root });
    await plugin.mdxJsxFlowElement(
      {
        attributes: [
          { name: "lang", type: "mdxJsxAttribute", value: "typescript" },
          { name: "meta", type: "mdxJsxAttribute", value: 'title="c"' },
          { name: "lang", type: "mdxJsxExpressionAttribute", value: "x" },
          { name: "cwd", type: "mdxJsxAttribute", value: null },
        ],
        name: "include",
        type: "mdxJsxFlowElement",
      },
      ctx
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.raw).toContain('```typescript title="c"');
  });

  it("ignores other jsx elements", async () => {
    const { ctx, replaced } = fakeCtx({});
    const plugin = includePlugin();
    await plugin.mdxJsxFlowElement(
      { name: "Callout", type: "mdxJsxFlowElement" },
      ctx
    );
    expect(replaced).toEqual([]);
  });

  it("renders an error block for an empty target", async () => {
    const { ctx, replaced, reports } = fakeCtx({
      fileURL: pathToFileURL("/tmp/p.mdx"),
      text: "",
    });
    await includePlugin().mdxJsxFlowElement(
      { name: "include", type: "mdxJsxFlowElement" },
      ctx
    );
    expect(replaced[0]?.raw).toContain("**Include error:**");
    expect(reports).toHaveLength(1);
  });

  it("renders an error block when the compiler passes no file URL", async () => {
    const { ctx, replaced, reports } = fakeCtx({ text: "./x.md" });
    await includePlugin().mdxJsxFlowElement(
      { name: "include", type: "mdxJsxFlowElement" },
      ctx
    );
    expect(replaced[0]?.raw).toContain("can't resolve");
    expect(reports).toHaveLength(1);
  });

  it("renders an error block for a missing target", async () => {
    const root = await fixture({ "p.mdx": "u" });
    const { ctx, replaced, reports } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.mdx")),
      text: "./gone.mdx",
    });
    await includePlugin({ contentRoot: root }).mdxJsxFlowElement(
      { name: "include", type: "mdxJsxFlowElement" },
      ctx
    );
    expect(replaced[0]?.raw).toContain("**Include error:**");
    expect(replaced[0]?.raw).toContain("was not found");
    expect(reports).toHaveLength(1);
  });

  it("splices the outer text and reports a nested error", async () => {
    const root = await fixture({
      "outer.md": "Outer.\n\n<include>./gone.md</include>\n",
      "p.mdx": "u",
    });
    const { ctx, replaced, reports } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.mdx")),
      text: "./outer.md",
    });
    await includePlugin({ contentRoot: root }).mdxJsxFlowElement(
      { name: "include", type: "mdxJsxFlowElement" },
      ctx
    );
    expect(replaced[0]?.raw).toContain("Outer.");
    expect(reports).toHaveLength(1);
  });

  it("splices statement lines inside a block html node", async () => {
    const root = await fixture({ "p.md": "u", "s.md": "Spliced.\n" });
    const { ctx, replaced } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.md")),
    });
    await includePlugin({ contentRoot: root }).html(
      {
        type: "html",
        value: "<div>\n<include>./s.md</include>\n</div>",
      },
      ctx
    );
    expect(replaced[0]?.raw).toBe("<div>\nSpliced.\n</div>");
  });

  it("skips html nodes without statements", async () => {
    const { ctx, replaced } = fakeCtx({});
    const plugin = includePlugin();
    await plugin.html({ type: "html", value: "<div>plain</div>" }, ctx);
    // An opening-tag fragment alone is not a statement either.
    await plugin.html({ type: "html", value: "<include>" }, ctx);
    expect(replaced).toEqual([]);
  });

  it("splices a paragraph-parsed statement via source positions", async () => {
    const root = await fixture({ "p.md": "u", "s.md": "Spliced.\n" });
    const source = "before\n\n<include>./s.md</include>\n\nafter\n";
    const offset = source.indexOf("<include");
    const { ctx, replaced } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.md")),
      source,
    });
    await includePlugin({ contentRoot: root }).paragraph(
      {
        position: {
          end: { offset: source.indexOf("</include>") + "</include>".length },
          start: { offset },
        },
        type: "paragraph",
      },
      ctx
    );
    expect(replaced[0]?.raw).toBe("Spliced.");
  });

  it("skips paragraphs without positions or statements", async () => {
    const { ctx, replaced } = fakeCtx({ source: "no statement here" });
    const plugin = includePlugin();
    await plugin.paragraph({ type: "paragraph" }, ctx);
    await plugin.paragraph(
      {
        position: { end: { offset: 4 }, start: { offset: 0 } },
        type: "paragraph",
      },
      ctx
    );
    expect(replaced).toEqual([]);
  });

  it("splices through the real markdown pipeline", async () => {
    const root = await fixture({
      "_snippets/shared.md": "## Spliced heading\n",
      "page.md": "u",
    });
    const processor = blumeMarkdownProcessor({ contentRoot: root });
    const renderer = await processor.createRenderer({});
    const result = await renderer.render(
      "# Page\n\n<include>./_snippets/shared.md</include>\n",
      { fileURL: pathToFileURL(join(root, "page.md")) }
    );
    expect(result.code).toContain("Spliced heading");
    expect(result.code).not.toContain("<include>");
  });

  it("keeps a blockquoted statement verbatim — the scanner never sees it", async () => {
    const root = await fixture({ "p.md": "u", "s.md": "Spliced.\n" });
    const source = "> <include>./s.md</include>\n";
    // The paragraph inside the blockquote starts after the `> ` marker; the
    // widened full-line slice restores the marker, so no statement matches.
    const start = source.indexOf("<include");
    const { ctx, replaced } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.md")),
      source,
    });
    await includePlugin({ contentRoot: root }).paragraph(
      {
        position: {
          end: { offset: source.indexOf("</include>") + "</include>".length },
          start: { offset: start },
        },
        type: "paragraph",
      },
      ctx
    );
    expect(replaced).toEqual([]);
  });

  it("keeps a list-item statement verbatim through the real pipeline", async () => {
    const root = await fixture({ "p.md": "u", "s.md": "Spliced body.\n" });
    const processor = blumeMarkdownProcessor({ contentRoot: root });
    const renderer = await processor.createRenderer({});
    const result = await renderer.render(
      "- <include>./s.md</include>\n\n> <include>./s.md</include>\n",
      { fileURL: pathToFileURL(join(root, "p.md")) }
    );
    expect(result.code).not.toContain("Spliced body.");
  });

  it("keeps a comment-interior statement verbatim in a block html node", async () => {
    const root = await fixture({ "p.md": "u", "s.md": "Spliced.\n" });
    const { ctx, replaced } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.md")),
    });
    const plugin = includePlugin({ contentRoot: root });
    // Entirely commented out: nothing matches, nothing is replaced.
    await plugin.html(
      { type: "html", value: "<!--\n<include>./s.md</include>\n-->" },
      ctx
    );
    expect(replaced).toEqual([]);
    // A live statement line beside a commented one: only the live one splices.
    await plugin.html(
      {
        type: "html",
        value:
          "<div>\n<include>./s.md</include>\n</div>\n<!--\n<include>./s.md</include>\n-->",
      },
      ctx
    );
    expect(replaced[0]?.raw).toBe(
      "<div>\nSpliced.\n</div>\n<!--\n<include>./s.md</include>\n-->"
    );
  });

  it("keeps an indented-code statement verbatim in .md visitors", async () => {
    const root = await fixture({ "p.md": "u", "s.md": "Spliced.\n" });
    const { ctx, replaced } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.md")),
    });
    await includePlugin({ contentRoot: root }).html(
      { type: "html", value: "<div>\n    <include>./s.md</include>\n</div>" },
      ctx
    );
    expect(replaced).toEqual([]);
  });

  it("rejects a statement wrapped across lines in .mdx", async () => {
    const root = await fixture({ "s.mdx": "Spliced.\n" });
    const { ctx, replaced, reports } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.mdx")),
      text: "./s.mdx",
    });
    await includePlugin({ contentRoot: root }).mdxJsxFlowElement(
      {
        name: "include",
        position: { end: { line: 3 }, start: { line: 1 } },
        type: "mdxJsxFlowElement",
      },
      ctx
    );
    expect(replaced[0]?.raw).toContain("single line");
    expect(reports).toHaveLength(1);
  });

  it("splices a single-line statement whose position is present", async () => {
    const root = await fixture({ "p.mdx": "u", "s.mdx": "Spliced.\n" });
    const { ctx, replaced } = fakeCtx({
      fileURL: pathToFileURL(join(root, "p.mdx")),
      text: "./s.mdx",
    });
    await includePlugin({ contentRoot: root }).mdxJsxFlowElement(
      {
        name: "include",
        position: { end: { line: 2 }, start: { line: 2 } },
        type: "mdxJsxFlowElement",
      },
      ctx
    );
    expect(replaced[0]?.raw).toBe("Spliced.");
  });
});

/** A fake Vite dev server capturing invalidations and websocket sends. */
const fakeServer = (modulesByFile: Record<string, unknown[]>) => {
  const invalidated: unknown[] = [];
  const sent: { type: string }[] = [];
  return {
    invalidated,
    sent,
    server: {
      moduleGraph: {
        getModulesByFile: (file: string) =>
          modulesByFile[file] ? new Set(modulesByFile[file]) : undefined,
        invalidateModule: (mod: never) => {
          invalidated.push(mod);
        },
      },
      ws: {
        send: (payload: { type: "full-reload" }) => {
          sent.push(payload);
        },
      },
    },
  };
};

describe("includeHmrPlugin", () => {
  it("invalidates every including page and full-reloads", async () => {
    const root = await fixture({ "p.md": "u" });
    const graphPath = join(root, "includes.json");
    const partial = join(root, "docs", "_s.md");
    const pageA = join(root, "docs", "a.md");
    const pageB = join(root, "docs", "b.md");
    await writeFile(graphPath, JSON.stringify({ [partial]: [pageA, pageB] }));
    const modA = { id: "a" };
    const { server, invalidated, sent } = fakeServer({ [pageA]: [modA] });
    const result = await includeHmrPlugin(graphPath).handleHotUpdate({
      file: partial,
      server,
    });
    expect(result).toEqual([]);
    expect(invalidated).toEqual([modA]);
    expect(sent).toEqual([{ type: "full-reload" }]);
  });

  it("defers to Vite for files with no includers", async () => {
    const root = await fixture({ "p.md": "u" });
    const graphPath = join(root, "includes.json");
    await writeFile(graphPath, JSON.stringify({ "/x": [] }));
    const { server, sent } = fakeServer({});
    const plugin = includeHmrPlugin(graphPath);
    expect(
      await plugin.handleHotUpdate({ file: "/not-a-partial", server })
    ).toBeUndefined();
    expect(
      await plugin.handleHotUpdate({ file: "/x", server })
    ).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("defers when the graph file does not exist yet", async () => {
    const { server } = fakeServer({});
    const result = await includeHmrPlugin(
      "/nowhere/includes.json"
    ).handleHotUpdate({ file: "/any", server });
    expect(result).toBeUndefined();
  });

  it("bumps each includer's mtime so the content layer re-syncs it", async () => {
    const root = await fixture({ "docs/a.md": "# A\n" });
    const graphPath = join(root, "includes.json");
    const partial = join(root, "docs", "_s.md");
    const pageA = join(root, "docs", "a.md");
    await writeFile(graphPath, JSON.stringify({ [partial]: [pageA] }));
    // Rewind the page's mtime so the bump is observable even on coarse
    // filesystem timestamp resolution.
    const past = new Date(Date.now() - 60_000);
    await utimes(pageA, past, past);
    const { server } = fakeServer({});
    await includeHmrPlugin(graphPath).handleHotUpdate({
      file: partial,
      server,
    });
    const after = await stat(pageA);
    expect(after.mtimeMs).toBeGreaterThan(past.getTime());
  });
});

describe("normalizeEntry with an expansion", () => {
  it("remaps link origins and passes unmapped lines through", () => {
    const { pages } = normalizeEntry(
      {
        body: { format: "md", text: "# X\n" },
        data: {},
        expanded: {
          includes: ["/abs/_snippets/s.md"],
          // One origin only: the second link's line has no mapping and must
          // pass through unchanged.
          origins: [{ file: "/abs/page.md", line: 5 }],
          text: "[a](/x)\n[b](/y)",
        },
        ref: "page.md",
        sourcePath: "/abs/page.md",
      },
      { defaultType: "doc", source: { name: "s", staged: false } }
    );
    const [page] = pages;
    expect(page?.includes).toEqual(["/abs/_snippets/s.md"]);
    expect(page?.links).toEqual([
      { column: 5, line: 5, target: "/x" },
      { column: 5, line: 2, target: "/y" },
    ]);
  });
});

/** A content source stub for the expansion-gate tests. */
const gateSource = (overrides: Partial<ContentSource>): ContentSource => ({
  load: () => Promise.reject(new Error("unused")),
  name: "cms",
  staged: false,
  ...overrides,
});

describe("readExpandedEntryText gates", () => {
  it("mirrors the scan's expansion gate for staged and root-less sources", async () => {
    const root = await fixture({ "s.md": "Spliced.\n" });
    const raw = "<include>./s.md</include>\n";
    await writeFile(join(root, "page.md"), raw);
    // SAFETY: readExpandedEntryText touches only sourcePath and source.name.
    const record = {
      source: { name: "cms", ref: "page" },
      sourcePath: join(root, "page.md"),
    } as PageRecord;
    // No matching source, a staged source, and a root-less source all pass
    // the raw text through — the scan expanded none of them, so expanding
    // here would splice text nothing validated.
    expect(await readExpandedEntryText({ sources: [] }, record)).toBe(raw);
    expect(
      await readExpandedEntryText(
        { sources: [gateSource({ contentRoot: root, staged: true })] },
        record
      )
    ).toBe(raw);
    expect(
      await readExpandedEntryText({ sources: [gateSource({})] }, record)
    ).toBe(raw);
    // The filesystem shape still expands.
    expect(
      await readExpandedEntryText(
        { sources: [gateSource({ contentRoot: root })] },
        record
      )
    ).toContain("Spliced.");
  });
});

const page = (title: string, body: string): string =>
  `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;

describe("includes through the project scan", () => {
  it("splices partial content into headings, links, search, and mirrors", async () => {
    const root = await fixture({
      "docs/_snippets/setup.mdx":
        "## Setup steps\n\nShared [broken](/nope) body text.\n",
      "docs/guide.mdx": page(
        "Guide",
        "<include>./_snippets/setup.mdx</include>"
      ),
      "docs/index.md": page("Home", "Body."),
    });
    const project = await scanProject(root, { mode: "build" });
    expect(
      project.diagnostics.filter((d) => d.code.startsWith("BLUME_INCLUDE"))
    ).toEqual([]);

    const guide = project.graph.pages.find((p) => p.route === "/guide");
    // The partial never becomes a page of its own (underscore exclude).
    expect(project.graph.pages.some((p) => p.id.includes("_snippets"))).toBe(
      false
    );
    // Its headings merge into the including page (TOC + anchor index).
    expect(guide?.headings.some((h) => h.slug === "setup-steps")).toBe(true);
    // The include edge is recorded for dev-server invalidation.
    expect(guide?.includes).toEqual([
      join(root, "docs", "_snippets", "setup.mdx"),
    ]);

    // A broken link inside the partial reports against the partial file.
    const diagnostics = await validateLinks(project.graph, {
      checkExternal: false,
      publicDir: null,
      redirects: [],
    });
    const broken = diagnostics.find((d) => d.code === "BLUME_BROKEN_LINK");
    expect(broken?.file).toBe(join(root, "docs", "_snippets", "setup.mdx"));
    expect(broken?.line).toBe(3);

    // Search indexes the spliced content under the including page.
    const documents = await buildSearchDocuments(project, {
      includeWhenDisabled: true,
    });
    const doc = documents.find((d) => d.route === "/guide");
    expect(doc?.content).toContain("Shared");
    expect(doc?.content).toContain("body text");

    // The raw-markdown mirrors serve the expanded document.
    const rawMarkdown = await buildRawMarkdown(project);
    expect(rawMarkdown["/guide"]?.mdx).toContain("## Setup steps");
    expect(rawMarkdown["/guide"]?.mdx).not.toContain("<include>");

    // readExpandedEntryText passes include-free pages through verbatim.
    const home = project.graph.pages.find((p) => p.route === "/");
    if (!home) {
      throw new Error("expected a home page");
    }
    expect(await readExpandedEntryText(project, home)).toContain("Body.");
  });

  it("surfaces a missing include as a scan diagnostic", async () => {
    const root = await fixture({
      "docs/index.md": page("Home", "<include>./_snippets/gone.mdx</include>"),
    });
    const project = await scanProject(root, { mode: "build" });
    const missing = project.diagnostics.find(
      (d) => d.code === "BLUME_INCLUDE_NOT_FOUND"
    );
    expect(missing?.severity).toBe("error");
    expect(missing?.file).toBe(join(root, "docs", "index.md"));
  });
});
