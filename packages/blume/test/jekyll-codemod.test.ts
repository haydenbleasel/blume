import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

// The blume-migrate skill's zero-dependency Jekyll (Just the Docs) codemod,
// run the way the skill runs it: a bare `node` over the repo-root copy (the
// package's `skills/` is a generated mirror of it).
const CODEMOD = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "skills",
  "blume-migrate",
  "scripts",
  "jekyll-codemod.mjs"
);

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

const spawnCodemod = (cwd: string, ...args: string[]) =>
  spawnSync("node", [CODEMOD, ...args], { cwd, encoding: "utf-8" });

const runCodemod = (cwd: string, ...args: string[]): string => {
  const result = spawnCodemod(cwd, ...args);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
};

/** A second `--write` refuses the folder and leaves it as it was. */
const expectRefusedRerun = (cwd: string, ...args: string[]) => {
  const again = spawnCodemod(cwd, ...args, "--write", ".");
  expect(again.status).toBe(1);
  expect(again.stderr).toContain("is already converted");
};

/** A fresh folder holding `files` (path → text). */
const tree = async (
  prefix: string,
  files: Record<string, string>
): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(([file, text]) => {
      const target = join(root, file);
      mkdirSync(join(target, ".."), { recursive: true });
      return writeFile(target, text);
    })
  );
  return root;
};

const read = (root: string, file: string): Promise<string> =>
  readFile(join(root, file), "utf-8");

const fence = "```";

/** A Jekyll page with just a title (and any extra front matter). */
const page = (title: string, extra = "") =>
  `---\ntitle: ${title}\n${extra}---\n\nBody of ${title}.\n`;
/** A built page whose <main> holds `main`. */
const html = (main = "") => `<html><body><main>${main}</main></body></html>\n`;

const CONFIG = [
  "title: Acme Docs",
  "url: https://docs.acme.dev",
  "permalink: pretty",
  "support-email: help@acme.dev",
  "callouts:",
  "  note:",
  "    title: Note",
  "    color: purple",
  "  new:",
  "    title: New",
  "    color: green",
  "  highlight:",
  "    color: yellow",
  "",
].join("\n");

const SETUP = [
  "---",
  "layout: default",
  "title: Setup",
  "nav_order: 2",
  "has_children: true",
  "---",
  "",
  "# Setting up `acme_cli`",
  "{: .no_toc }",
  "",
  '<details open markdown="block">',
  "  <summary>Table of contents</summary>",
  "  {: .text-delta }",
  "1. TOC",
  "{:toc}",
  "</details>",
  "",
  "{: .note }",
  "A prefix note.",
  "",
  "A postfix highlight.",
  "{: .highlight }",
  "",
  "{: .new-title }",
  "> Fresh",
  ">",
  "> The body of a titled callout.",
  "",
  "{: .note }",
  "> {: .new }",
  "> A nested callout.",
  "",
  "Plain text.",
  "{: info}",
  "",
  "Styled by a theme that's gone.",
  "{: .notice--warning}",
  "",
  "{: .note }",
  "- a list Just the Docs never boxed",
  "",
  `${fence}md`,
  "# Not a heading",
  "{: .note }",
  "A paragraph inside code.",
  fence,
  "",
  "## Advanced {#adv}",
  "",
  "### Notes",
  "{: .no_toc }",
  "",
  "New in 2.0",
  "{: .label .label-green }",
  "",
  "[Download](https://acme.dev/dl){: .btn .btn-primary }",
  "",
  "Email {{ site.support-email }} for help.",
  "",
  "<!-- a hidden comment -->",
  '<img src="/media/a.png" alt="A">',
  "",
  "Compare a <> b, or read <https://acme.dev>.",
  "",
].join("\n");

describe("jekyll-codemod", () => {
  it("converts IAL callouts, the TOC, the H1, and front matter, and is idempotent", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": CONFIG,
      "guide/setup.md": SETUP,
    });

    const dry = runCodemod(root, ".");
    expect(dry).toContain("guide/setup.md → guide/setup.mdx");
    expect(dry).toContain("Re-run with --write to apply.");
    expect(existsSync(join(root, "guide", "setup.mdx"))).toBe(false);

    runCodemod(root, "--write", ".");
    const converted = await read(root, "guide/setup.mdx");
    expect(converted).toBe(
      [
        "---",
        "title: Setting up acme_cli",
        "sidebar:",
        "  label: Setup",
        "seo:",
        "  title: Setup",
        "---",
        "",
        ":::note",
        "A prefix note.",
        ":::",
        "",
        ":::info",
        "A postfix highlight.",
        ":::",
        "",
        ":::success[Fresh]",
        "The body of a titled callout.",
        ":::",
        "",
        "::::note",
        ":::success[New]",
        "A nested callout.",
        ":::",
        "::::",
        "",
        "Plain text.",
        "",
        "Styled by a theme that's gone.",
        "",
        "- a list Just the Docs never boxed",
        "",
        `${fence}md`,
        "# Not a heading",
        "{: .note }",
        "A paragraph inside code.",
        fence,
        "",
        "## Advanced [#adv]",
        "",
        "### Notes [!toc]",
        "",
        '<Badge color="green">New in 2.0</Badge>',
        "",
        "[Download](https://acme.dev/dl)",
        "",
        "Email {{support-email}} for help.",
        "",
        "{/* a hidden comment */}",
        '<img src="/media/a.png" alt="A" />',
        "",
        "Compare a &lt;> b, or read [https://acme.dev](https://acme.dev).",
        "",
      ].join("\n")
    );
    const migration = JSON.parse(await read(root, "jekyll-migration.json"));
    expect(migration.variables).toEqual({ "support-email": "help@acme.dev" });
    expect(dry).toContain(
      ".notice--warning isn't a callout under callouts: in _config.yml"
    );
    expect(dry).toContain("{: info } is malformed");
    expect(dry).toContain(".note sat on a list");

    expectRefusedRerun(root);
    expect(await read(root, "guide/setup.mdx")).toBe(converted);
  });

  it("turns Markdown includes into <include> with props, nested, and leaves the rest", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": CONFIG,
      "_includes/inner.md": "Inner sees {{ include.depth }}.\n",
      "_includes/outer.md": [
        "Outer sees {{ include.level }}.",
        "",
        '{% include inner.md depth="2" %}',
        "",
      ].join("\n"),
      "_includes/toc.md": "1. TOC\n{:toc}\n",
      "_includes/video.html": '<iframe src="{{ include.id }}"></iframe>\n',
      "page.md": [
        "---",
        "title: Page",
        "---",
        "",
        "{% include toc.md %}",
        "",
        "{% include /outer.md level='one' flag=true %}",
        "",
        "{% include outer.md level=page.level %}",
        "",
        '{% include video.html id="abc" %}',
        "",
        `${fence}liquid`,
        '{% include outer.md level="kept" %}',
        fence,
        "",
      ].join("\n"),
    });
    const out = runCodemod(root, "--write", ".");
    expect(await read(root, "page.md")).toBe(
      [
        "---",
        "title: Page",
        "---",
        "",
        '<include level="one" flag="true">/_includes/outer.md</include>',
        "",
        "{% include outer.md level=page.level %}",
        "",
        '{% include video.html id="abc" %}',
        "",
        `${fence}liquid`,
        '{% include outer.md level="kept" %}',
        fence,
        "",
      ].join("\n")
    );
    expect(await read(root, "_includes/outer.md")).toBe(
      [
        "Outer sees {{level}}.",
        "",
        '<include depth="2">/_includes/inner.md</include>',
        "",
      ].join("\n")
    );
    expect(await read(root, "_includes/inner.md")).toBe(
      "Inner sees {{depth}}.\n"
    );
    expect(out).toContain("level=page.level passes a variable");
    expect(out).toContain(
      "_includes/video.html isn't Markdown (an HTML partial is embedded as code, not spliced)"
    );
    expect(out).toContain("Liquid in a code block");
  });

  it("splits a space-separated tags string into a list, and keeps a list", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": CONFIG,
      "guide/list.md": "---\ntitle: List\ntags: [one, two]\n---\n\nText.\n",
      "guide/words.md": "---\ntitle: Words\ntags: foo bar  baz\n---\n\nText.\n",
    });
    const report = runCodemod(root, "--write", ".");
    expect(report).toContain("1 × front matter tags split into a list");
    expect(await read(root, "guide/words.md")).toContain(
      "tags:\n  - foo\n  - bar\n  - baz\n"
    );
    expect(await read(root, "guide/list.md")).toContain(
      "tags:\n  - one\n  - two\n"
    );
  });

  it("removes empty and blank tags, which Blume's schema rejects", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": CONFIG,
      "guide/blank.md": '---\ntitle: Blank\ntags: "  "\n---\n\nText.\n',
      "guide/empty.md": "---\ntitle: Empty\ntags:\n---\n\nText.\n",
      "guide/holes.md":
        '---\ntitle: Holes\ntags: [a, "", null]\n---\n\nText.\n',
    });
    const report = runCodemod(root, "--write", ".");
    expect(report).toContain("2 × empty front matter tags removed");
    expect(report).toContain("1 × blank front matter tags removed");
    expect(await read(root, "guide/empty.md")).not.toContain("tags");
    expect(await read(root, "guide/blank.md")).not.toContain("tags");
    expect(await read(root, "guide/holes.md")).toContain("tags:\n  - a\n---");
  });

  it("leaves {% raw %} content exactly as written", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": CONFIG,
      "page.md": [
        "---",
        "title: Raw",
        "---",
        "",
        "{% raw %}",
        `${fence}liquid`,
        "{% include note.md %}",
        "{{ site.support-email }}",
        "{: .note }",
        fence,
        "{% endraw %}",
        "",
        "Inline {% raw %}`{{ page.title }}`{% endraw %} stays.",
        "",
        "Rendered: {{ site.title }}.",
        "",
      ].join("\n"),
    });
    const out = runCodemod(root, "--write", ".");
    expect(await read(root, "page.md")).toBe(
      [
        "---",
        "title: Raw",
        "---",
        "",
        `${fence}liquid`,
        "{% include note.md %}",
        "{{ site.support-email }}",
        "{: .note }",
        fence,
        "",
        "Inline `{{ page.title }}` stays.",
        "",
        "Rendered: {{title}}.",
        "",
      ].join("\n")
    );
    expect(out).not.toContain("Liquid in a code block");
    const migration = JSON.parse(await read(root, "jekyll-migration.json"));
    expect(migration.variables).toEqual({ title: "Acme Docs" });
  });

  it("rewrites links against the old pretty URLs", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": `${CONFIG}baseurl: /docs\n`,
      "guide/diagram.png": "png",
      "guide/index.md": "---\ntitle: Guide\n---\n\n[setup](./setup/)\n",
      "guide/intro.md": "---\ntitle: Intro\n---\n\nIntro.\n",
      "guide/setup.md": [
        "---",
        "title: Setup",
        "---",
        "",
        "[sibling](../intro/), [file](intro.md#start),",
        "[own site](https://docs.acme.dev/docs/guide/intro/),",
        "[home]({{ site.baseurl }}{% link index.md %}),",
        '[root]({{ "/guide/intro/" | relative_url }}),',
        "[slashed](/guide/intro/#start), [gone](../missing/).",
        "",
        "![diagram](../diagram.png)",
        "",
        '<a href="../intro/">raw</a>',
        "",
        "`[code](../intro/)` stays.",
        "",
      ].join("\n"),
      "index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const out = runCodemod(root, "--write", ".");
    expect(await read(root, "guide/setup.md")).toBe(
      [
        "---",
        "title: Setup",
        "---",
        "",
        "[sibling](/guide/intro), [file](/guide/intro#start),",
        "[own site](/guide/intro),",
        "[home](/),",
        "[root](/guide/intro),",
        "[slashed](/guide/intro#start), [gone](../missing/).",
        "",
        "![diagram](./diagram.png)",
        "",
        '<a href="/guide/intro">raw</a>',
        "",
        "`[code](../intro/)` stays.",
        "",
      ].join("\n")
    );
    expect(await read(root, "guide/index.md")).toContain(
      "[setup](/guide/setup)"
    );
    expect(out).toContain(
      "relative link ../missing/ reached /guide/missing/ on the old site"
    );
  });

  it("adds .html redirects and redirect_from entries on a non-pretty site", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": [
        "title: Plain",
        "defaults:",
        "  - scope:",
        "      path: legacy",
        "    values:",
        "      permalink: /old/:basename/",
        "",
      ].join("\n"),
      "a.md": [
        "---",
        "title: A",
        "redirect_from:",
        "  - /old-a/",
        "  - /a.html",
        "---",
        "",
        "See [b](b.html).",
        "",
      ].join("\n"),
      "b.md": "---\ntitle: B\nredirect_to: https://acme.dev/b\n---\n",
      "index.md": "---\ntitle: Home\n---\n\nHome.\n",
      "legacy/c.md": "---\ntitle: C\n---\n\nC.\n",
      "notes.md": "No front matter, so Jekyll copied this file as is.\n",
    });
    const out = runCodemod(root, "--write", ".");
    expect(await read(root, "a.md")).toBe(
      "---\ntitle: A\n---\n\nSee [b](/b).\n"
    );
    // A permalink from `defaults:` applies to pages too.
    expect(await read(root, "legacy/c.md")).toBe(
      "---\ntitle: C\nslug: old/c\n---\n\nC.\n"
    );
    expect(existsSync(join(root, "b.md"))).toBe(false);
    const migration = JSON.parse(await read(root, "jekyll-migration.json"));
    expect(migration.redirects).toEqual([
      { from: "/a.html", to: "/a" },
      { from: "/b", to: "https://acme.dev/b" },
      { from: "/b.html", to: "/b" },
      { from: "/old-a/", to: "/a" },
    ]);
    expect(out).toContain(
      "redirect_from /a.html is empty or the page's own URL"
    );
    expect(out).toContain("Not pages (no front matter");
  });

  it("drops <script> and <style> from an MDX page, end tags with spaces too", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": "title: Plain\npermalink: pretty\n",
      "a.md": [
        "---",
        "title: A",
        "---",
        "",
        "Math $$x$$ makes this page MDX.",
        "",
        "<script>",
        "alert(1)",
        "</script >",
        '<style media="print">p {}</style',
        ">",
        "",
        "After.",
        "",
      ].join("\n"),
    });
    const out = runCodemod(root, "--write", ".");
    expect(await read(root, "a.mdx")).toBe(
      "---\ntitle: A\n---\n\nMath $$x$$ makes this page MDX.\n\nAfter.\n"
    );
    expect(out).toContain("1 × <script> removed (MDX)");
    expect(out).toContain("1 × <style> removed (MDX)");
  });

  it("reads CRLF files, and converts the callouts --callouts names", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": "title: Plain\r\npermalink: pretty\r\n",
      "a.md": "---\r\ntitle: A\r\n---\r\n\r\n{: .note }\r\nWindows.\r\n",
    });
    // The dry run names what the write run needs: --callouts.
    const dry = runCodemod(root, ".");
    expect(dry).toContain("_config.yml declares no callouts:");
    expect(dry).toContain("Kramdown attribute list left: {: .note }");

    runCodemod(root, "--callouts", "note", "--write", ".");
    expect(await read(root, "a.mdx")).toBe(
      "---\ntitle: A\n---\n\n:::note\nWindows.\n:::\n"
    );
  });

  it("applies IALs to the block Kramdown did, and keeps inline code and hidden headings as written", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": `${CONFIG}version: "3.2"\n`,
      "a.md": [
        "---",
        "title: A",
        "---",
        "",
        "<!--",
        "# An old heading",
        "-->",
        "",
        "# The {{ site.title }} guide {{ site.version }}",
        "{: .no_toc }",
        "",
        "* TOC",
        "{:toc}",
        "",
        "A paragraph a list interrupts",
        "- one",
        "{: .note }",
        "",
        "{: .note }",
        "A prefix paragraph",
        "- two",
        "",
        "1. Step",
        "   {: .note }",
        "",
        "{: .highlight }",
        "",
        "Kramdown applies an IAL that stands alone to the next block.",
        "",
        "Keep `<!-- more -->`, `<br>`, and `<https://acme.dev>` in code, and a real <br>.",
        "",
        "{% raw %}",
        `${fence}handlebars`,
        "{{ version }}",
        fence,
        "{% endraw %}",
        "",
      ].join("\n"),
    });
    const out = runCodemod(root, "--write", ".");
    expect(await read(root, "a.mdx")).toBe(
      [
        "---",
        "title: The Acme Docs guide 3.2",
        "sidebar:",
        "  label: A",
        "seo:",
        "  title: A",
        "---",
        "",
        "{/* # An old heading */}",
        "",
        "A paragraph a list interrupts",
        "- one",
        "",
        ":::note",
        "A prefix paragraph",
        ":::",
        "",
        "- two",
        "",
        "1. Step",
        "",
        ":::info",
        "Kramdown applies an IAL that stands alone to the next block.",
        ":::",
        "",
        "Keep `<!-- more -->`, `<br>`, and `<https://acme.dev>` in code, and a real <br />.",
        "",
        `${fence}handlebars`,
        "{{ version }}",
        fence,
        "",
      ].join("\n")
    );
    expect(out).toContain(".note sat on a list");
    expect(out).toContain(".note sat inside a list item");
    expect(out).toContain(
      "{{ version }} sat in {% raw %}, so the old page printed it as written"
    );
  });

  it("passes the parameters an include left out, and splices include_relative partials", async () => {
    const root = await tree("blume-jekyll-codemod-", {
      "_config.yml": `${CONFIG}baseurl: /docs\n`,
      "_includes/figure.md": [
        "![{{ include.alt }}](/img.png)",
        "",
        "{{ include.caption }}",
        "",
      ].join("\n"),
      "guide/_parts/steps.md": "Steps for [intro](../intro/).\n",
      "guide/diagram.png": "png",
      "guide/intro.md": "---\ntitle: Intro\n---\n\nIntro.\n",
      "guide/setup.md": [
        "---",
        "title: Setup",
        "---",
        "",
        '{% include figure.md alt="A figure" %}',
        "",
        "{% include_relative _parts/steps.md %}",
        "",
        '<img src="../diagram.png" alt="raw"> ![md](../diagram.png)',
        "",
      ].join("\n"),
    });
    const out = runCodemod(root, "--write", ".");
    expect(await read(root, "guide/setup.md")).toBe(
      [
        "---",
        "title: Setup",
        "---",
        "",
        '<include alt="A figure" caption="">/_includes/figure.md</include>',
        "",
        "<include>/guide/_parts/steps.md</include>",
        "",
        '<img src="/guide/diagram.png" alt="raw"> ![md](./diagram.png)',
        "",
      ].join("\n")
    );
    expect(await read(root, "guide/_parts/steps.md")).toBe(
      "Steps for [intro](/guide/intro).\n"
    );
    // Blume adds the base to a raw root path, as to a Markdown one.
    expect(out).not.toContain("deployment.base");
    expect(out).toContain("serve that file from public/guide/diagram.png");
  });

  it("rebuilds the old sidebar as folders, slugs, and meta.ts files", async () => {
    const nav = [
      '<nav aria-label="Main" id="site-nav" class="site-nav">',
      '<ul class="nav-list">',
      '<li class="nav-list-item"><a href="/" class="nav-list-link">Home</a></li>',
      '<li class="nav-list-item"><a href="/docs/setup/" class="nav-list-link">Setup</a>',
      '<ul class="nav-list">',
      '<li class="nav-list-item"><a href="/docs/install/" class="nav-list-link">Install</a></li>',
      '<li class="nav-list-item"><a href="/docs/configure/" class="nav-list-link">Configure</a></li>',
      "</ul></li>",
      '<li class="nav-list-item"><a href="/ref/" class="nav-list-link">Reference</a>',
      '<ul class="nav-list">',
      '<li class="nav-list-item"><a href="/ref/errors/" class="nav-list-link">Errors</a></li>',
      "</ul></li>",
      '<li class="nav-list-item"><a href="/guide/" class="nav-list-link">Getting started</a>',
      '<ul class="nav-list">',
      '<li class="nav-list-item"><a href="/guide/basics/" class="nav-list-link">Basics</a></li>',
      '<li class="nav-list-item"><a href="/reference/api/" class="nav-list-link">API ref</a></li>',
      '<li class="nav-list-item"><a href="/ref/errors/" class="nav-list-link">Errors</a></li>',
      "</ul></li>",
      '<li class="nav-list-item"><a href="https://github.com/acme" class="nav-list-link">GitHub</a></li>',
      "</ul></nav>",
    ].join("\n");
    const root = await tree("blume-jekyll-codemod-", {
      "old/docs/configure/index.html": html(),
      "old/docs/install/index.html": html(),
      "old/docs/setup/index.html": html(
        '<hr>\n<h2 class="text-delta">Table of contents</h2>\n<ul>\n<li>\n<a href="/docs/install/">Install</a>\n</li>\n</ul>'
      ),
      "old/guide/basics/index.html": html(),
      "old/guide/index.html": html(),
      "old/hidden/index.html": html(),
      "old/index.html": `<html><body>${nav}<main></main></body></html>\n`,
      "old/ref/errors/index.html": html(),
      "old/ref/index.html": html(),
      "old/reference/api/index.html": html(),
      "site/_config.yml": "title: Acme\npermalink: pretty\n",
      "site/docs/configure.md": page("Configure", "parent: Setup\n"),
      "site/docs/install.md": page("Install", "parent: Setup\n"),
      "site/docs/setup.md": page("Setup", "has_children: true\n"),
      "site/guide/basics.md": page("Basics", "parent: Guide\n"),
      "site/guide/index.md": page("Guide"),
      "site/hidden.md": page("Hidden", "nav_exclude: true\n"),
      "site/index.md": page("Home"),
      "site/ref/errors.md": page("Errors", "parent: Reference\n"),
      "site/ref/index.md":
        "---\ntitle: Reference\nhas_children: true\n---\n\n# The API reference\n\nEvery endpoint.\n",
      "site/reference/api.md": page("API ref", "parent: Guide\n"),
    });
    const site = join(root, "site");
    const out = runCodemod(site, "--old", "../old", "--write", ".");

    expect(await read(site, "docs/(setup)/index.md")).toBe(
      [
        "---",
        "title: Setup",
        "slug: docs/setup",
        "sidebar:",
        "  hidden: true",
        "---",
        "",
        "Body of Setup.",
        "",
      ].join("\n")
    );
    expect(await read(site, "docs/(setup)/install.md")).toBe(
      "---\ntitle: Install\n---\n\nBody of Install.\n"
    );
    expect(existsSync(join(site, "docs", "(setup)", "configure.md"))).toBe(
      true
    );
    expect(await read(site, "guide/api.md")).toBe(
      "---\ntitle: API ref\nslug: reference/api\n---\n\nBody of API ref.\n"
    );
    expect(await read(site, "hidden.md")).toContain("  hidden: true");
    expect(await read(site, "guide/index.md")).not.toContain("hidden");

    const meta = (folder: string) => read(site, join(folder, "meta.ts"));
    expect(await meta("docs/(setup)")).toBe(
      [
        "// Generated by jekyll-codemod.mjs from the old site's sidebar.",
        'import { defineMeta } from "blume";',
        "",
        "export default defineMeta({",
        '  directory: "accordion",',
        "  pages: [",
        '    "install",',
        '    "configure",',
        "  ],",
        "});",
        "",
      ].join("\n")
    );
    // Its H1 is the title and its old title the sidebar.label, which names
    // the folder title, so Blume's index check passes with the row hidden.
    expect(await read(site, "ref/index.md")).toBe(
      [
        "---",
        "title: The API reference",
        "sidebar:",
        "  label: Reference",
        "  hidden: true",
        "seo:",
        "  title: Reference",
        "---",
        "",
        "Every endpoint.",
        "",
      ].join("\n")
    );
    expect(await meta("ref")).toContain('title: "Reference",');
    expect(existsSync(join(site, "ref", "errors.md"))).toBe(true);
    expect(out).toContain(
      'ref/errors.md ("Errors") is listed again under another section'
    );
    expect(await meta("guide")).toContain('title: "Getting started",');
    expect(await meta("guide")).toContain('    "basics",\n    "api",');
    expect(await meta("docs")).toContain("collapsed: false,");
    expect(await meta(".")).toContain('    "docs",\n    "ref",\n    "guide",');
    expect(out).toContain(
      'nav link "GitHub" (https://github.com/acme) is external'
    );
    expect(out).toContain(
      'its title "Guide" differs from the section label "Getting started"'
    );

    const before = await meta("docs/(setup)");
    expectRefusedRerun(site, "--old", "../old");
    expect(await meta("docs/(setup)")).toBe(before);
  });

  it("hides a home page the old sidebar never showed", async () => {
    const nav = [
      '<nav aria-label="Main" id="site-nav" class="site-nav">',
      '<ul class="nav-list">',
      '<li class="nav-list-item"><a href="/docs/install/" class="nav-list-link">Install</a></li>',
      '<li class="nav-list-item"><a href="/docs/usage/" class="nav-list-link">Usage</a></li>',
      "</ul></nav>",
    ].join("\n");
    const root = await tree("blume-jekyll-codemod-", {
      "old/docs/install/index.html": html(),
      "old/docs/usage/index.html": html(),
      "old/index.html": `<html><body>${nav}<main></main></body></html>\n`,
      "site/_config.yml": "title: Acme\npermalink: pretty\n",
      "site/docs/install.md": page("Install"),
      "site/docs/usage.md": page("Usage"),
      "site/index.md": page("Home", "nav_exclude: true\n"),
    });
    const site = join(root, "site");
    const out = runCodemod(site, "--old", "../old", "--write", ".");

    // Hidden, the home page stays in search, the sitemap, and llms.txt, so
    // the note about hidden pages leaving them doesn't count it.
    expect(await read(site, "index.md")).toBe(
      "---\ntitle: Home\nsidebar:\n  hidden: true\n---\n\nBody of Home.\n"
    );
    expect(out).not.toContain("outside the old sidebar are hidden");
    expect(await read(site, "docs/meta.ts")).toContain("collapsed: false,");
  });
});
