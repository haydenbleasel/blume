import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { migrateMintlify } from "../src/migrate/migrate.ts";
import { loadMintlifyConfig } from "../src/migrate/mintlify/config.ts";
import {
  rewriteMintlifyCallouts,
  rewriteMintlifyExampleBlocks,
  rewriteSnippetImports,
  unsupportedMintlifyComponents,
} from "../src/migrate/mintlify/content.ts";
import {
  normalizeMintlifyPageMeta,
  stripUnknownPageMeta,
} from "../src/migrate/mintlify/frontmatter.ts";
import { rewriteMintlifySvgIconProps } from "../src/migrate/mintlify/icons.ts";
import { rewriteMintlifyGlobalVariables } from "../src/migrate/mintlify/snippets.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-mintlify-"));
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

describe("loadMintlifyConfig", () => {
  it("maps docs.json branding, theme, navbar, and footer", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        appearance: { default: "dark", strict: true },
        colors: { dark: "#15803D", light: "#07C983", primary: "#16A34A" },
        description: "Garden docs",
        footer: { socials: { github: "https://gh", x: "https://x" } },
        name: "Garden",
        navbar: {
          primary: { href: "https://gh", label: "GitHub", type: "button" },
        },
      }),
    });

    const config = await loadMintlifyConfig(root, join(root, "docs.json"));

    expect(config.title).toBe("Garden");
    expect(config.description).toBe("Garden docs");
    expect(config.theme?.accent).toBe("#16A34A");
    expect(config.theme?.mode).toBe("dark");
    expect(config.content?.root).toBe(".");
    expect(config.navbar).toBeDefined();
    expect(config.footer).toBeDefined();
  });

  it("builds a sidebar from navigation groups", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        name: "Docs",
        navigation: {
          pages: [{ group: "Start", pages: ["index", "quickstart"] }],
        },
      }),
    });

    const config = await loadMintlifyConfig(root, join(root, "docs.json"));
    expect(Array.isArray(config.navigation?.sidebar)).toBe(true);
    expect(JSON.stringify(config.navigation?.sidebar)).toContain("quickstart");
  });
});

describe("frontmatter normalization", () => {
  it("folds Mintlify keys into Blume's shape", () => {
    const mapped = normalizeMintlifyPageMeta({
      canonical: "https://x/y",
      hidden: true,
      icon: "rocket",
      "og:image": "https://x/card.png",
      sidebarTitle: "Short",
      tag: "New",
      title: "Page",
    });

    expect(mapped.sidebar).toEqual({
      badge: "New",
      hidden: true,
      icon: "rocket",
      label: "Short",
    });
    expect(mapped.seo).toEqual({
      canonical: "https://x/y",
      image: "https://x/card.png",
    });
    expect(mapped.noindex).toBe(true);
    expect(mapped.sidebarTitle).toBeUndefined();
    expect(mapped.canonical).toBeUndefined();
  });

  it("strips keys Blume's strict schema rejects", () => {
    const { data, removed } = stripUnknownPageMeta({
      "og:locale": "en_US",
      title: "Page",
      "twitter:card": "summary",
    });
    expect(removed.toSorted()).toEqual(["og:locale", "twitter:card"]);
    expect(data).toEqual({ title: "Page" });
  });
});

describe("content rewrites", () => {
  it("converts Mintlify callouts to directives", () => {
    expect(rewriteMintlifyCallouts("<Note>Careful</Note>")).toBe(
      ":::note\nCareful\n:::"
    );
    expect(
      rewriteMintlifyCallouts('<Warning title="Heads up">Risky</Warning>')
    ).toBe(":::warning[Heads up]\nRisky\n:::");
    expect(
      rewriteMintlifyCallouts('<Callout type="info">Context</Callout>')
    ).toBe(":::info\nContext\n:::");
  });

  it("converts a callout with a JSX-expression icon attribute", () => {
    const input =
      '<Callout type="tip" title="SVG" icon={<svg viewBox="0 0 1 1"><path d="M0 0" /></svg>} color="#fff">\n  Body text.\n</Callout>';
    const out = rewriteMintlifyCallouts(input);
    expect(out).toBe(":::tip[SVG]\nBody text.\n:::");
  });

  it("renames request/response example blocks to CodeGroup", () => {
    const out = rewriteMintlifyExampleBlocks(
      "<RequestExample>\na\n</RequestExample><ResponseExample>b</ResponseExample>"
    );
    expect(out).toBe("<CodeGroup>\na\n</CodeGroup><CodeGroup>b</CodeGroup>");
  });

  it("normalizes inline-SVG icon props to strings", () => {
    const out = rewriteMintlifySvgIconProps(
      '<Icon icon={<svg viewBox="0 0 1 1"><path d="M0 0" /></svg>} />'
    );
    expect(out).toContain('icon={"');
    expect(out).not.toContain("icon={<svg");
  });

  it("substitutes docs.json globals", () => {
    expect(
      rewriteMintlifyGlobalVariables("Welcome to {{product-name}}.", {
        "product-name": "Acme",
      })
    ).toBe("Welcome to Acme.");
  });

  it("reports components without a Blume equivalent", () => {
    expect(unsupportedMintlifyComponents('<ParamField name="x" />')).toEqual([
      "ParamField",
    ]);
  });

  it("drops dead markdown snippet imports and relativizes component imports", () => {
    const input = [
      'import Note from "/snippets/note.mdx";',
      'import { Widget } from "/snippets/widget.jsx";',
    ].join("\n");
    const { source, components } = rewriteSnippetImports(input, {
      filePath: "/proj/guide/page.mdx",
      root: "/proj",
    });
    expect(source).not.toContain("note.mdx");
    expect(source).toContain('from "../snippets/widget.jsx"');
    expect(components).toEqual(["snippets/widget.jsx"]);
  });
});

describe("migrateMintlify end to end", () => {
  const buildProject = () =>
    project({
      "docs.json": JSON.stringify({
        colors: { primary: "#16A34A" },
        favicon: "/favicon.svg",
        logo: { dark: "/logo/dark.svg", light: "/logo/light.svg" },
        name: "My Docs",
        navigation: { pages: [{ group: "Start", pages: ["index"] }] },
        variables: { "product-name": "Acme" },
      }),
      "favicon.svg": "<svg/>",
      "index.mdx": [
        "---",
        'title: "Home"',
        'sidebarTitle: "Start here"',
        'canonical: "https://x/home"',
        "noindex: true",
        '"twitter:card": "summary"',
        "---",
        "",
        'import Shared from "/snippets/note.mdx";',
        "",
        "Welcome to {{product-name}}.",
        "",
        "<Shared />",
        "",
        "<Note>Careful now</Note>",
      ].join("\n"),
      "logo/dark.svg": "<svg/>",
      "logo/light.svg": "<svg/>",
      "snippets/note.mdx": ":::tip\nShared snippet body\n:::\n",
    });

  it("writes a config, rewrites content, and relocates assets", async () => {
    const root = await buildProject();
    const result = await migrateMintlify(root);

    const config = await readFile(join(root, "blume.config.ts"), "utf-8");
    expect(config).toContain('from "blume"');
    expect(config).toContain('"accent": "#16A34A"');
    expect(config).toContain('"title": "My Docs"');

    const page = await readFile(join(root, "index.mdx"), "utf-8");
    // Global variable inlined.
    expect(page).toContain("Welcome to Acme.");
    // Snippet inlined (import line removed, body inlined).
    expect(page).not.toContain("import Shared");
    expect(page).toContain("Shared snippet body");
    // Callout converted to a directive.
    expect(page).toContain(":::note");
    expect(page).not.toContain("<Note>");
    // Frontmatter folded and stripped.
    expect(page).toContain("sidebar:");
    expect(page).toContain("Start here");
    expect(page).not.toContain("twitter:card");

    // Assets relocated under public/, originals removed.
    expect(existsSync(join(root, "public", "logo", "light.svg"))).toBe(true);
    expect(existsSync(join(root, "public", "favicon.svg"))).toBe(true);
    expect(existsSync(join(root, "logo"))).toBe(false);

    // Snippets inlined and the directory removed.
    expect(existsSync(join(root, "snippets"))).toBe(false);

    expect(result.moved).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("public/"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("snippets"))).toBe(true);
  });

  it("migrates the bundled examples/mintlify fixture without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-mintlify-ex-"));
    dirs.push(root);
    const fixture = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "examples",
      "mintlify"
    );
    await cp(fixture, root, {
      filter: (src) =>
        !/(?:\.blume|dist|node_modules|\.turbo)(?:\/|$)/u.test(src),
      recursive: true,
    });
    await rm(join(root, "package.json"), { force: true });
    await rm(join(root, "README.md"), { force: true });

    const result = await migrateMintlify(root);

    expect(existsSync(join(root, "blume.config.ts"))).toBe(true);
    expect(result.moved).toBeGreaterThan(0);
    // A markdown snippet import in components.mdx is inlined.
    const components = await readFile(join(root, "components.mdx"), "utf-8");
    expect(components).not.toContain('from "/snippets/shared-note.mdx"');
  });
});
