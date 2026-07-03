import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { loadFumadocsConfig } from "../src/migrate/fumadocs/config.ts";
import {
  inlineFumadocsIncludes,
  rewriteFumadocsCallouts,
  rewriteFumadocsContainers,
  rewriteFumadocsTabs,
  stripFumadocsImports,
  unsupportedFumadocsComponents,
} from "../src/migrate/fumadocs/content.ts";
import { normalizeFumadocsPageMeta } from "../src/migrate/fumadocs/frontmatter.ts";
import { reshapeFumadocsGroups } from "../src/migrate/fumadocs/groups.ts";
import {
  parseFumadocsPages,
  translateFumadocsMeta,
} from "../src/migrate/fumadocs/meta.ts";
import type { FumadocsPagesStructure } from "../src/migrate/fumadocs/meta.ts";
import { migrateFumadocs } from "../src/migrate/migrate.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-fuma-"));
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

describe("translateFumadocsMeta", () => {
  it("maps title, icon, defaultOpen, and root", () => {
    const closed = translateFumadocsMeta({
      defaultOpen: false,
      icon: "Book",
      title: "Guides",
    });
    expect(closed.meta).toEqual({
      collapsed: true,
      display: "group",
      icon: "Book",
      title: "Guides",
    });

    const open = translateFumadocsMeta({ defaultOpen: true });
    expect(open.meta).toEqual({ collapsed: false, display: "group" });

    expect(translateFumadocsMeta({ root: true }).meta.display).toBe("page");
  });

  it("filters separators, links, and the rest marker from pages", () => {
    const { meta, warnings } = translateFumadocsMeta({
      description: "ignored",
      pages: [
        "index",
        "guides",
        "---Resources---",
        "[GitHub](https://github.com)",
        "...",
      ],
    });

    expect(meta.pages).toEqual(["index", "guides"]);
    expect(warnings.some((w) => w.includes("separator"))).toBe(true);
    expect(warnings.some((w) => w.includes("link"))).toBe(true);
    expect(warnings.some((w) => w.includes("description"))).toBe(true);
  });

  it("keeps an extract `...folder` as a folder ordering key and warns", () => {
    const { meta, warnings } = translateFumadocsMeta({
      pages: ["index", "...providers", "guides"],
    });

    expect(meta.pages).toEqual(["index", "providers", "guides"]);
    expect(warnings.some((w) => w.includes('"...providers"'))).toBe(true);
    expect(meta.pages).not.toContain("...providers");
  });

  it("ignores non-object meta and non-string page entries", () => {
    expect(translateFumadocsMeta(null).meta).toEqual({});
    expect(translateFumadocsMeta([1, 2]).meta).toEqual({});

    const { meta } = translateFumadocsMeta({
      pages: ["index", 5, "  ", "guides"],
    });
    expect(meta.pages).toEqual(["index", "guides"]);
  });
});

describe("parseFumadocsPages", () => {
  it("splits lead items from separator-introduced sections", () => {
    const structure = parseFumadocsPages([
      "index",
      "guides",
      "---Getting Started---",
      "installation",
      "...providers",
      "[GitHub](https://github.com)",
      "...",
    ]);

    expect(structure.hasSections).toBe(true);
    expect(structure.lead).toEqual([
      { kind: "ref", name: "index" },
      { kind: "ref", name: "guides" },
    ]);
    expect(structure.sections).toHaveLength(1);
    const [section] = structure.sections;
    expect(section?.label).toBe("Getting Started");
    expect(section?.items).toEqual([
      { kind: "ref", name: "installation" },
      { kind: "extract", name: "providers" },
      { href: "https://github.com", kind: "link", text: "GitHub" },
    ]);
  });

  it("reports no sections for a flat, separator-free list", () => {
    const structure = parseFumadocsPages(["index", "guides", "..."]);
    expect(structure.hasSections).toBe(false);
    expect(structure.sections).toEqual([]);
    expect(structure.lead).toEqual([
      { kind: "ref", name: "index" },
      { kind: "ref", name: "guides" },
    ]);
  });

  it("defaults an unlabeled separator and ignores non-arrays", () => {
    expect(parseFumadocsPages("nope")).toEqual({
      hasSections: false,
      lead: [],
      sections: [],
    });
    expect(parseFumadocsPages(["------", "a"]).sections[0]?.label).toBe(
      "Section"
    );
  });
});

describe("normalizeFumadocsPageMeta", () => {
  it("keeps known fields and drops Fumadocs-only `full`", () => {
    const { data, removed } = normalizeFumadocsPageMeta({
      description: "d",
      full: true,
      title: "T",
    });
    expect(data.title).toBe("T");
    expect(data.description).toBe("d");
    expect(data.full).toBeUndefined();
    expect(removed).toContain("full");
  });
});

describe("rewriteFumadocsCallouts", () => {
  it("maps callout types to directives", () => {
    expect(
      rewriteFumadocsCallouts('<Callout type="warn">Be careful</Callout>')
    ).toBe(":::warning\nBe careful\n:::");
    expect(rewriteFumadocsCallouts('<Callout type="error">Bad</Callout>')).toBe(
      ":::danger\nBad\n:::"
    );
    expect(rewriteFumadocsCallouts("<Callout>Plain</Callout>")).toBe(
      ":::note\nPlain\n:::"
    );
    expect(
      rewriteFumadocsCallouts(
        '<Callout type="info" title="Heads up">Body</Callout>'
      )
    ).toBe(":::info[Heads up]\nBody\n:::");
  });
});

describe("rewriteFumadocsContainers", () => {
  it("renames Cards, Accordions, and Files trees", () => {
    expect(rewriteFumadocsContainers("<Cards><Card title='a' /></Cards>")).toBe(
      "<CardGroup><Card title='a' /></CardGroup>"
    );
    expect(
      rewriteFumadocsContainers(
        '<Accordions><Accordion title="Q">A</Accordion></Accordions>'
      )
    ).toBe('<Accordion><AccordionItem title="Q">A</AccordionItem></Accordion>');
    expect(
      rewriteFumadocsContainers(
        '<Files><Folder name="src"><File name="i.ts" /></Folder></Files>'
      )
    ).toBe(
      '<FileTree><TreeFolder name="src"><TreeFile name="i.ts" /></TreeFolder></FileTree>'
    );
  });
});

describe("rewriteFumadocsTabs", () => {
  it("hoists items + value into per-Tab titles", () => {
    const out = rewriteFumadocsTabs(
      `<Tabs items={['npm', 'pnpm']}>\n<Tab value="npm">a</Tab>\n<Tab value="pnpm">b</Tab>\n</Tabs>`
    );
    expect(out).toContain("<Tabs>");
    expect(out).toContain('<Tab title="npm">a</Tab>');
    expect(out).toContain('<Tab title="pnpm">b</Tab>');
    expect(out).not.toContain("items=");
    expect(out).not.toContain("value=");
  });

  it("titles value-less tabs positionally from items", () => {
    const out = rewriteFumadocsTabs(
      `<Tabs items={['One', 'Two']}>\n<Tab>first</Tab>\n<Tab>second</Tab>\n</Tabs>`
    );
    expect(out).toContain('<Tab title="One">first</Tab>');
    expect(out).toContain('<Tab title="Two">second</Tab>');
  });

  it("keeps a Tab that already declares its own title", () => {
    const out = rewriteFumadocsTabs(
      `<Tabs items={['npm']}>\n<Tab title="Keep">a</Tab>\n</Tabs>`
    );
    expect(out).toContain('<Tab title="Keep">a</Tab>');
  });

  it("leaves value-less tabs untitled when there are no items", () => {
    const out = rewriteFumadocsTabs(
      `<Tabs>\n<Tab>a</Tab>\n<Tab>b</Tab>\n</Tabs>`
    );
    expect(out).toContain("<Tabs>");
    expect(out).toContain("<Tab>a</Tab>");
    expect(out).not.toContain("title=");
  });

  it("ignores a non-expression items attribute", () => {
    const out = rewriteFumadocsTabs(
      `<Tabs items="oops">\n<Tab value="x">a</Tab>\n</Tabs>`
    );
    expect(out).toContain('items="oops"');
    expect(out).toContain('<Tab title="x">a</Tab>');
  });

  it("drops items from a self-closing Tabs tag", () => {
    expect(rewriteFumadocsTabs("<Tabs items={['a', 'b']} />")).toBe("<Tabs />");
  });

  it("leaves an unterminated Tabs open tag untouched", () => {
    const src = "before <Tabs items={[ unterminated";
    expect(rewriteFumadocsTabs(src)).toBe(src);
  });

  it("leaves a Tabs block with no closing tag untouched", () => {
    const src = `<Tabs items={['a']}>\n<Tab>a</Tab>`;
    expect(rewriteFumadocsTabs(src)).toBe(src);
  });

  it("leaves a Tab with an unterminated open tag untouched", () => {
    const out = rewriteFumadocsTabs(
      `<Tabs items={['a']}>\n<Tab value={oops\n</Tabs>`
    );
    expect(out).toContain("<Tab value={oops");
  });

  it("skips nested tab groups when titling the outer tabs", () => {
    const out = rewriteFumadocsTabs(
      [
        "<Tabs items={['Outer A', 'Outer B']}>",
        '<Tab value="a">',
        "<Tabs items={['Inner']}>",
        '<Tab value="x">deep</Tab>',
        "</Tabs>",
        "</Tab>",
        '<Tab value="b">two</Tab>',
        "</Tabs>",
      ].join("\n")
    );
    expect(out).toContain('<Tab title="a">');
    expect(out).toContain('<Tab title="x">deep</Tab>');
    expect(out).toContain('<Tab title="b">two</Tab>');
    expect(out).not.toContain("items=");
  });

  it("passes a malformed nested Tabs (unterminated open tag) through intact", () => {
    const out = rewriteFumadocsTabs(
      `<Tabs items={['x']}>\n<Tabs items={[\n<Tab value="z">z</Tab>\n</Tabs>\n</Tabs>`
    );
    // The outer group is still normalized (its items prop is dropped)...
    expect(out.startsWith("<Tabs>")).toBe(true);
    // ...while the broken inner group is left untouched rather than corrupted.
    expect(out).toContain("<Tabs items={[");
    expect(out).toContain('<Tab value="z">z</Tab>');
  });
});

describe("stripFumadocsImports", () => {
  it("drops fumadocs package imports", () => {
    const out = stripFumadocsImports(
      'import { Tab, Tabs } from "fumadocs-ui/components/tabs";\n\n# Title\n'
    );
    expect(out).not.toContain("fumadocs-ui");
    expect(out).toContain("# Title");
  });
});

describe("unsupportedFumadocsComponents", () => {
  it("reports components with no Blume equivalent", () => {
    expect(unsupportedFumadocsComponents("<ImageZoom src='x' />")).toEqual([
      "ImageZoom",
    ]);
    expect(unsupportedFumadocsComponents("<Card />")).toEqual([]);
  });
});

describe("inlineFumadocsIncludes", () => {
  it("inlines an included partial and strips its frontmatter", async () => {
    const root = await project({
      "_partial.mdx": "---\ntitle: Partial\n---\n\nShared content.\n",
      "page.mdx": "Before.\n\n<include>./_partial.mdx</include>\n\nAfter.\n",
    });

    const result = await inlineFumadocsIncludes(
      await readFile(join(root, "page.mdx"), "utf-8"),
      { filePath: join(root, "page.mdx"), root }
    );

    expect(result.content).toContain("Shared content.");
    expect(result.content).not.toContain("<include>");
    expect(result.content).not.toContain("title: Partial");
  });

  it("warns and leaves a missing include untouched", async () => {
    const root = await project({ "page.mdx": "x\n" });
    const result = await inlineFumadocsIncludes(
      "<include>./missing.mdx</include>",
      { filePath: join(root, "page.mdx"), root }
    );
    expect(result.content).toContain("<include>");
    expect(result.warnings.some((w) => w.includes("not found"))).toBe(true);
  });

  it("refuses an include that escapes the docs root", async () => {
    const root = await project({ "page.mdx": "x\n" });
    const result = await inlineFumadocsIncludes(
      "<include>../../secret.txt</include>",
      { filePath: join(root, "docs", "page.mdx"), root: join(root, "docs") }
    );
    expect(result.content).toContain("<include>");
    expect(
      result.warnings.some((w) => w.includes("outside the docs tree"))
    ).toBe(true);
  });

  it("ignores an empty include and reports a circular one", async () => {
    const root = await project({
      "_self.mdx": "---\ntitle: Self\n---\n\n<include>./_self.mdx</include>\n",
      "page.mdx": "<include></include>\n\n<include>./_self.mdx</include>\n",
    });

    const result = await inlineFumadocsIncludes(
      await readFile(join(root, "page.mdx"), "utf-8"),
      { filePath: join(root, "page.mdx"), root }
    );

    expect(result.warnings.some((w) => w.includes("Circular"))).toBe(true);
  });
});

describe("loadFumadocsConfig", () => {
  it("derives a title and preserves the loader base URL", async () => {
    const root = await project({
      "lib/source.ts":
        'export const source = loader({ baseUrl: "/docs", source });\n',
      "package.json": JSON.stringify({ name: "@acme/my-docs" }),
    });

    const { config, warnings } = await loadFumadocsConfig(root);

    expect(config.title).toBe("My Docs");
    expect(config.content?.sources?.[0]).toMatchObject({
      prefix: "docs",
      root: "docs",
      type: "filesystem",
    });
    expect(warnings.some((w) => w.includes("/docs"))).toBe(true);
  });

  it("serves from the site root when the loader baseUrl is '/'", async () => {
    const root = await project({
      "lib/source.ts":
        'export const source = loader({ baseUrl: "/", source });\n',
      "package.json": JSON.stringify({ name: "root-docs" }),
    });

    const { config, warnings } = await loadFumadocsConfig(root);

    expect(config.title).toBe("Root Docs");
    expect(config.content).toBeUndefined();
    expect(warnings.some((w) => w.includes("site root"))).toBe(true);
  });

  it("defaults the title to Documentation when no name is usable", async () => {
    const missing = await loadFumadocsConfig(
      await project({ "package.json": "{}" })
    );
    expect(missing.config.title).toBe("Documentation");

    const blank = await loadFumadocsConfig(
      await project({ "package.json": JSON.stringify({ name: "   " }) })
    );
    expect(blank.config.title).toBe("Documentation");

    const scoped = await loadFumadocsConfig(
      await project({ "package.json": JSON.stringify({ name: "@scope/" }) })
    );
    expect(scoped.config.title).toBe("Documentation");
  });

  it("defaults the title to Documentation for an unparseable package.json", async () => {
    const root = await project({ "package.json": "{ not json" });
    const { config } = await loadFumadocsConfig(root);
    expect(config.title).toBe("Documentation");
  });

  it("falls back to the repo name for a generic monorepo package name", async () => {
    const root = await project({
      "myrepo/.git/HEAD": "ref: refs/heads/main\n",
      "myrepo/apps/web/lib/source.ts":
        'export const source = loader({ baseUrl: "/docs" });\n',
      "myrepo/apps/web/package.json": JSON.stringify({ name: "web" }),
    });

    const { config } = await loadFumadocsConfig(
      join(root, "myrepo", "apps", "web")
    );
    // "Web" (from the apps/web package name) is a weak title; the repo dir wins.
    expect(config.title).toBe("Myrepo");
  });

  it("prettifies a generic package name when no git repo is found above it", async () => {
    // No `.git` anywhere up the tmp tree, so the repo-name fallback is skipped
    // and the generic name is title-cased directly.
    const root = await project({
      "package.json": JSON.stringify({ name: "web" }),
    });
    const { config } = await loadFumadocsConfig(root);
    expect(config.title).toBe("Web");
  });

  it("keeps the generic package name when the repo dir prettifies to nothing", async () => {
    const base = await mkdtemp(join(tmpdir(), "blume-fuma-repo-"));
    dirs.push(base);
    // A repo dir whose basename yields no words (`___`) can't title the docs, so
    // the migrator falls back to prettifying the generic package name.
    const repo = join(base, "___");
    await mkdir(join(repo, ".git"), { recursive: true });
    const app = join(repo, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "web" }));

    const { config } = await loadFumadocsConfig(app);
    expect(config.title).toBe("Web");
  });
});

describe("migrateFumadocs end to end", () => {
  it("migrates the bundled examples/fumadocs fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-fuma-ex-"));
    dirs.push(root);
    const fixture = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "examples",
      "fumadocs"
    );
    await cp(fixture, root, {
      filter: (src) =>
        !/(?:\.blume|dist|node_modules|\.turbo)(?:\/|$)/u.test(src),
      recursive: true,
    });

    const result = await migrateFumadocs(root);

    expect(result.moved).toBeGreaterThan(0);
    const config = await readFile(join(root, "blume.config.ts"), "utf-8");
    expect(config).toContain('"prefix": "docs"');
    expect(config).toContain('"title": "Fumadocs"');

    const index = await readFile(join(root, "docs", "index.mdx"), "utf-8");
    expect(index).toContain(":::info[Heads up]");
    expect(index).toContain("<CardGroup>");
    expect(index).not.toContain("fumadocs-ui");

    const setup = await readFile(
      join(root, "docs", "guides", "setup.mdx"),
      "utf-8"
    );
    expect(setup).toContain('<Tab title="npm">');
    expect(setup).toContain("<AccordionItem");
    expect(setup).toContain("<TreeFile");
    expect(setup).not.toContain("full:");

    const rootMeta = await readFile(join(root, "docs", "meta.ts"), "utf-8");
    expect(rootMeta).toContain('"title": "Docs"');
    expect(rootMeta).toContain('"index"');
    expect(rootMeta).toContain('"guides"');
    // The "Resources" section held only a link, so it leaves no group folder.
    expect(rootMeta).not.toContain("Resources");
    expect(rootMeta).not.toContain("GitHub");
    expect(existsSync(join(root, "docs", "(Resources)"))).toBe(false);

    const guidesMeta = await readFile(
      join(root, "docs", "guides", "meta.ts"),
      "utf-8"
    );
    expect(guidesMeta).toContain('"display": "group"');
    expect(guidesMeta).toContain('"collapsed": false');

    expect(existsSync(join(root, "content"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("link"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("full"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("/docs"))).toBe(true);
  });

  it("keeps meta.json when the target meta.ts already exists", async () => {
    const root = await project({
      "content/docs/guide/index.mdx": "# Guide\n",
      "content/docs/guide/meta.json": JSON.stringify({
        pages: ["index"],
        title: "Guide Title",
      }),
      "content/docs/index.mdx": "# Home\n",
      // A pre-existing meta.ts at the destination: the conversion is skipped,
      // so the source must NOT be deleted — that would silently lose the
      // title and page ordering with nowhere to recover them from.
      "docs/guide/meta.ts": 'export default { title: "Existing" };\n',
    });

    const result = await migrateFumadocs(root);

    expect(
      await readFile(join(root, "docs", "guide", "meta.ts"), "utf-8")
    ).toBe('export default { title: "Existing" };\n');
    expect(
      existsSync(join(root, "content", "docs", "guide", "meta.json"))
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.includes("target already exists") && w.includes("kept")
      )
    ).toBe(true);
  });

  it("rebuilds flat-file sections as route-transparent group folders", async () => {
    const root = await project({
      "content/docs/configuration.mdx": "# Config\n",
      "content/docs/index.mdx": "# Home\n",
      "content/docs/installation.mdx": "# Install\n",
      "content/docs/meta.json": JSON.stringify({
        pages: [
          "index",
          "---Getting Started---",
          "installation",
          "configuration",
          "---Providers---",
          "...providers",
        ],
        title: "Docs",
      }),
      "content/docs/providers/anthropic.mdx": "# Anthropic\n",
      "content/docs/providers/openai.mdx": "# OpenAI\n",
    });

    const result = await migrateFumadocs(root);

    // The "Getting Started" section's flat files move into a group folder,
    // which is stripped from URLs, so the pages keep their routes.
    const groupDir = join(root, "docs", "(Getting Started)");
    expect(existsSync(join(groupDir, "installation.mdx"))).toBe(true);
    expect(existsSync(join(groupDir, "configuration.mdx"))).toBe(true);
    expect(existsSync(join(root, "docs", "installation.mdx"))).toBe(false);

    // A meta.ts inside the group preserves the section's authored page order.
    const sectionMeta = await readFile(join(groupDir, "meta.ts"), "utf-8");
    expect(sectionMeta.indexOf("installation")).toBeLessThan(
      sectionMeta.indexOf("configuration")
    );

    // The single-folder "Providers" section keeps the folder in place — wrapping
    // it would stack two headings.
    expect(existsSync(join(root, "docs", "providers", "openai.mdx"))).toBe(
      true
    );
    expect(existsSync(join(root, "docs", "(Providers)"))).toBe(false);

    // The lead page stays at the top level; the parent meta orders the sections.
    expect(existsSync(join(root, "docs", "index.mdx"))).toBe(true);
    const rootMeta = await readFile(join(root, "docs", "meta.ts"), "utf-8");
    expect(rootMeta.indexOf('"index"')).toBeLessThan(
      rootMeta.indexOf('"Getting Started"')
    );
    expect(rootMeta.indexOf('"Getting Started"')).toBeLessThan(
      rootMeta.indexOf('"providers"')
    );
    expect(result.warnings.some((w) => w.includes("...providers"))).toBe(true);
  });

  it("tears down the old Next/Fumadocs scaffolding", async () => {
    const root = await project({
      "app/page.tsx": "export default function Page() {\n  return null;\n}\n",
      "content/docs/index.mdx": "# Home\n",
      "mdx-components.tsx": "export const useMDXComponents = (c) => c;\n",
      "next.config.ts": "export default {};\n",
      "package.json": JSON.stringify({
        name: "docs-app",
        scripts: {
          build: "next build",
          dev: "next dev",
          postinstall: "fumadocs-mdx",
          start: "next start",
        },
      }),
      "source.config.ts": "export const docs = {};\n",
    });

    const result = await migrateFumadocs(root);

    // Scripts repointed at the Blume CLI; the fumadocs-mdx postinstall dropped.
    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf-8")
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts).toEqual({
      build: "blume build",
      dev: "blume dev",
      start: "blume preview",
    });

    // Blume's outputs are ignored.
    const gitignore = await readFile(join(root, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".blume/");
    expect(gitignore).toContain("dist/");

    // The leftover framework files are surfaced as a delete checklist.
    expect(
      result.warnings.some(
        (w) =>
          w.includes("Safe to delete") &&
          w.includes("next.config.ts") &&
          w.includes("source.config.ts") &&
          w.includes("mdx-components.tsx") &&
          w.includes("app")
      )
    ).toBe(true);
  });

  it("writes a default config when there is no content/docs", async () => {
    const root = await project({ "README.md": "# Hi\n" });

    const result = await migrateFumadocs(root);

    expect(result.moved).toBe(0);
    const config = await readFile(join(root, "blume.config.ts"), "utf-8");
    expect(config).toContain('"title": "Documentation"');
    expect(
      result.warnings.some((w) => w.includes("No Fumadocs content directory"))
    ).toBe(true);
  });

  it("skips pages and metas whose destinations already exist", async () => {
    const root = await project({
      "content/docs/bad/meta.json": "{ not json",
      "content/docs/index.mdx": "# Source\n",
      "content/docs/meta.json": JSON.stringify({
        pages: ["index"],
        title: "Docs",
      }),
      "docs/bad/meta.json": "// existing\n",
      "docs/index.mdx": "# Existing\n",
      "docs/meta.ts": "// existing\n",
    });

    const result = await migrateFumadocs(root);

    expect(result.moved).toBe(0);
    expect(result.warnings.some((w) => w.includes("Skipped index.mdx"))).toBe(
      true
    );
    expect(result.warnings.some((w) => w.includes("Skipped meta.json"))).toBe(
      true
    );
    expect(
      result.warnings.some((w) => w.includes("Skipped bad/meta.json"))
    ).toBe(true);
    const kept = await readFile(join(root, "docs", "index.mdx"), "utf-8");
    expect(kept).toContain("# Existing");
  });

  it("relocates unparseable metas, flags unsupported components, keeps leftovers", async () => {
    const root = await project({
      "content/docs/bad/meta.json": "{ broken",
      "content/docs/index.mdx": '# Home\n\n<ImageZoom src="/x.png" />\n',
      "content/docs/notes.txt": "leftover\n",
    });

    const result = await migrateFumadocs(root);

    expect(result.moved).toBe(1);
    expect(existsSync(join(root, "docs", "bad", "meta.json"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Could not parse"))).toBe(
      true
    );
    expect(result.warnings.some((w) => w.includes("ImageZoom"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Kept"))).toBe(true);
  });
});

describe("reshapeFumadocsGroups", () => {
  it("keeps lead links out (warning) and lead extracts in (warning)", async () => {
    const docsDir = await project({ "guide.mdx": "# Guide\n" });
    const structure: FumadocsPagesStructure = {
      hasSections: false,
      lead: [
        { kind: "ref", name: "guide" },
        { kind: "extract", name: "providers" },
        { href: "https://example.com", kind: "link", text: "GitHub" },
      ],
      sections: [],
    };

    const { order, warnings } = await reshapeFumadocsGroups(structure, docsDir);

    expect(order).toEqual(["guide", "providers"]);
    expect(warnings.some((w) => w.includes("Dropped sidebar link"))).toBe(true);
    expect(warnings.some((w) => w.includes('"...providers"'))).toBe(true);
  });

  it("leaves a single-folder section in place and warns when the label differs", async () => {
    const docsDir = await project({ "openai/index.mdx": "# OpenAI\n" });
    const structure: FumadocsPagesStructure = {
      hasSections: true,
      lead: [],
      sections: [
        { items: [{ kind: "ref", name: "openai" }], label: "Providers" },
      ],
    };

    const { order, warnings } = await reshapeFumadocsGroups(structure, docsDir);

    expect(order).toEqual(["openai"]);
    // A lone folder keeps its place — no wrapping `(Providers)/` group folder.
    expect(existsSync(join(docsDir, "(Providers)"))).toBe(false);
    expect(existsSync(join(docsDir, "openai"))).toBe(true);
    expect(warnings.some((w) => w.includes('wraps folder "openai"'))).toBe(
      true
    );
  });

  it("wraps a single-file section into a group folder", async () => {
    const docsDir = await project({ "solo.mdx": "# Solo\n" });
    const structure: FumadocsPagesStructure = {
      hasSections: true,
      lead: [],
      sections: [{ items: [{ kind: "ref", name: "solo" }], label: "Solo" }],
    };

    const { order } = await reshapeFumadocsGroups(structure, docsDir);

    expect(order).toEqual(["Solo"]);
    expect(existsSync(join(docsDir, "(Solo)", "solo.mdx"))).toBe(true);
    expect(existsSync(join(docsDir, "solo.mdx"))).toBe(false);
  });

  it("leaves a slash-labeled section ungrouped and warns", async () => {
    const docsDir = await project({ "a.mdx": "# A\n", "b.mdx": "# B\n" });
    const structure: FumadocsPagesStructure = {
      hasSections: true,
      lead: [],
      sections: [
        {
          items: [
            { kind: "ref", name: "a" },
            { href: "https://example.com", kind: "link", text: "L" },
            { kind: "ref", name: "b" },
          ],
          label: "Group/Sub",
        },
      ],
    };

    const { order, warnings } = await reshapeFumadocsGroups(structure, docsDir);

    expect(order).toEqual(["a", "b"]);
    expect(warnings.some((w) => w.includes("slash in its name"))).toBe(true);
    // No group folder is created; the files stay at the top level.
    expect(existsSync(join(docsDir, "a.mdx"))).toBe(true);
  });

  it("skips missing, duplicate, and escaping items when moving a section", async () => {
    const docsDir = await project({
      "(Group)/dup.mdx": "# Existing dup\n",
      "dup.mdx": "# Dup\n",
      "ext.mdx": "# Ext\n",
      "keep.mdx": "# Keep\n",
    });
    const structure: FumadocsPagesStructure = {
      hasSections: true,
      lead: [],
      sections: [
        {
          items: [
            { kind: "ref", name: "keep" },
            { kind: "ref", name: "missing" },
            { kind: "ref", name: "dup" },
            { kind: "ref", name: "../escape" },
            { kind: "extract", name: "ext" },
            { href: "https://example.com", kind: "link", text: "L" },
          ],
          label: "Group",
        },
      ],
    };

    const { order, warnings } = await reshapeFumadocsGroups(structure, docsDir);

    expect(order).toEqual(["Group"]);
    // Movable files land in the group; the extract does too (with a warning).
    expect(existsSync(join(docsDir, "(Group)", "keep.mdx"))).toBe(true);
    expect(existsSync(join(docsDir, "(Group)", "ext.mdx"))).toBe(true);
    // A name whose destination already exists is left where it was.
    expect(existsSync(join(docsDir, "dup.mdx"))).toBe(true);
    expect(warnings.some((w) => w.includes("matched no page or folder"))).toBe(
      true
    );
    expect(warnings.some((w) => w.includes("target already exists"))).toBe(
      true
    );
    expect(warnings.some((w) => w.includes("Dropped sidebar link"))).toBe(true);
    expect(warnings.some((w) => w.includes('"...ext"'))).toBe(true);
  });
});
