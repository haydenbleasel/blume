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
import { translateFumadocsMeta } from "../src/migrate/fumadocs/meta.ts";
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
      { filePath: join(root, "page.mdx") }
    );

    expect(result.content).toContain("Shared content.");
    expect(result.content).not.toContain("<include>");
    expect(result.content).not.toContain("title: Partial");
  });

  it("warns and leaves a missing include untouched", async () => {
    const root = await project({ "page.mdx": "x\n" });
    const result = await inlineFumadocsIncludes(
      "<include>./missing.mdx</include>",
      { filePath: join(root, "page.mdx") }
    );
    expect(result.content).toContain("<include>");
    expect(result.warnings.some((w) => w.includes("not found"))).toBe(true);
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
    expect(rootMeta).not.toContain("Resources");
    expect(rootMeta).not.toContain("GitHub");

    const guidesMeta = await readFile(
      join(root, "docs", "guides", "meta.ts"),
      "utf-8"
    );
    expect(guidesMeta).toContain('"display": "group"');
    expect(guidesMeta).toContain('"collapsed": false');

    expect(existsSync(join(root, "content"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("separator"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("full"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("/docs"))).toBe(true);
  });
});
