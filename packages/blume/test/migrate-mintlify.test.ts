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
import { normalizeMintlifyPageMeta } from "../src/migrate/mintlify/frontmatter.ts";
import { mintlifyI18n } from "../src/migrate/mintlify/i18n.ts";
import { rewriteMintlifySvgIconProps } from "../src/migrate/mintlify/icons.ts";
import {
  rewriteMintlifyGlobalVariables,
  rewriteMintlifyMarkdownSnippets,
  rewriteMintlifySnippetVariables,
} from "../src/migrate/mintlify/snippets.ts";
import { stripUnknownPageMeta } from "../src/migrate/shared.ts";

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
  it("maps docs.json branding and theme", async () => {
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

describe("loadMintlifyConfig navigation shapes", () => {
  it("builds a sidebar from top-level navigation groups", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        name: "Grouped",
        navigation: {
          groups: [{ group: "Reference", pages: ["api", "cli"] }],
        },
      }),
    });

    const config = await loadMintlifyConfig(root, join(root, "docs.json"));
    const sidebar = JSON.stringify(config.navigation?.sidebar);
    expect(sidebar).toContain("Reference");
    expect(sidebar).toContain("cli");
  });

  it("maps tabs, anchors, dropdowns, products, versions, and language chrome", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        name: "Nav",
        navbar: {
          links: [
            { href: "https://github.com/acme/x", type: "github" },
            { href: "https://discord.gg/acme", type: "discord" },
            { href: "https://no-label.example", type: "button" },
            { href: "https://blog.example", icon: "rss", label: "Blog" },
          ],
          primary: { href: "https://gh.example", type: "github" },
        },
        navigation: {
          dropdowns: [
            {
              description: "Cloud docs",
              dropdown: "Cloud",
              href: "/cloud",
              icon: "cloud",
              tag: "Beta",
            },
            { href: "/no-label" },
            "string-dropdown",
          ],
          global: {
            anchors: [
              { anchor: "Changelog", href: "/changelog", icon: "clock" },
            ],
          },
          languages: [
            {
              banner: { content: "EN banner" },
              default: true,
              footer: { socials: { x: "https://x.example" } },
              language: "en",
              navbar: {
                links: [{ href: "https://gh.example", type: "github" }],
              },
              root: "en",
            },
            { language: "fr", root: "fr" },
            { href: "https://ext-lang.example", language: "ext" },
          ],
          products: [{ href: "/pro", product: "Pro" }],
          tabs: [
            {
              icon: "book",
              menu: [
                { href: "/guides/intro", item: "Intro" },
                "guides/menu-page",
                { href: "https://ext.example", item: "Ext" },
                { href: "/nolabel-menu" },
                null,
              ],
              pages: [
                "guides/index",
                {
                  expanded: false,
                  group: "Advanced",
                  pages: ["guides/advanced/one", "guides/advanced/two"],
                },
                {
                  expanded: true,
                  group: "Collapsed open",
                  pages: ["guides/open"],
                },
                { group: "Reference", root: "reference" },
                { pages: ["loose/a"] },
                null,
              ],
              root: "guides",
              tab: "Guides",
            },
            "string-tab",
            { href: "https://example.com", tab: "External" },
            { tab: "Empty" },
            { root: "guides", tab: "Guides" },
          ],
          versions: [{ href: "/v2", version: "v2" }],
        },
      }),
    });

    const config = await loadMintlifyConfig(root, join(root, "docs.json"));
    const nav = config.navigation;

    const tabsJson = JSON.stringify(nav?.tabs);
    expect(tabsJson).toContain("Guides");
    expect(tabsJson).toContain("Changelog");
    // The duplicate Guides tab is deduplicated.
    expect(tabsJson.split('"label":"Guides"').length - 1).toBe(1);

    const kinds = nav?.selectors?.map((selector) => selector.kind) ?? [];
    expect(kinds).toContain("dropdown");
    expect(kinds).toContain("product");
    expect(kinds).toContain("version");
    expect(kinds).toContain("language");

    const chromeJson = JSON.stringify(nav?.chromeVariants);
    expect(chromeJson).toContain("EN banner");
    expect(chromeJson).toContain('"path":"/en"');

    const sidebarJson = JSON.stringify(nav?.sidebar);
    expect(sidebarJson).toContain("Advanced");
    expect(sidebarJson).toContain("Reference");

    expect(Array.isArray(nav?.sidebarVariants)).toBe(true);
    expect((nav?.sidebarVariants?.length ?? 0) > 0).toBe(true);
  });
});

describe("loadMintlifyConfig branding", () => {
  it("maps banner, background, redirects, and code theme", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        background: {
          color: { dark: "#000", light: "#fff" },
          decoration: "grid",
          image: "bg.png",
        },
        banner: {
          color: { dark: "#111", light: "#eee" },
          content: "Heads up",
          dismissible: true,
          type: "warning",
        },
        contextual: {
          display: "toc",
          options: [
            "copy",
            {
              description: "Ask",
              href: "https://chatgpt.example",
              icon: "bot",
              title: "ChatGPT",
            },
            { description: "no title" },
          ],
        },
        favicon: { dark: "/fav-dark.svg", light: "/fav-light.svg" },
        footer: {
          links: [
            "bad-group",
            { header: "Empty", items: [] },
            {
              header: "Resources",
              items: [{ href: "/docs", label: "Docs" }, { label: "no-href" }],
            },
          ],
          socials: { blank: "", github: "https://gh.example" },
        },
        logo: { dark: "/logo-dark.svg", href: "/", light: "/logo-light.svg" },
        name: "Brand",
        redirects: [
          "bad",
          { destination: "/new", source: "/old" },
          { from: "/x", redirect: "/y" },
          { source: "/incomplete" },
        ],
        styling: {
          codeblocks: { theme: "github-light" },
          eyebrows: "breadcrumbs",
          latex: false,
        },
      }),
    });

    const config = await loadMintlifyConfig(root, join(root, "docs.json"));

    const banner = config.banner as
      | { color?: { dark?: string; light?: string }; content?: string }
      | undefined;
    expect(banner?.content).toBe("Heads up");
    expect(banner?.color).toEqual({ dark: "#111", light: "#eee" });
    expect(config.theme?.backgroundImage).toBe("bg.png");
    expect(config.theme?.backgroundDecoration).toBe("grid");
    expect(config.favicon).toEqual({
      dark: "/fav-dark.svg",
      light: "/fav-light.svg",
    });
    expect(config.logo).toEqual({
      dark: "/logo-dark.svg",
      href: "/",
      light: "/logo-light.svg",
    });
    expect(config.redirects).toContainEqual({ from: "/old", to: "/new" });
    expect(config.redirects).toContainEqual({ from: "/x", to: "/y" });
    expect(config.redirects).toHaveLength(2);
    expect(config.markdown?.codeBlocks?.theme).toEqual({
      dark: "github-light",
      light: "github-light",
    });
    expect(config.markdown?.math).toBe(false);
  });

  it("drops empty logo/favicon objects and maps code-theme variants", async () => {
    const empty = await project({
      "docs.json": JSON.stringify({
        favicon: {},
        logo: { note: "x" },
        name: "Empty",
      }),
    });
    const emptyConfig = await loadMintlifyConfig(
      empty,
      join(empty, "docs.json")
    );
    expect(emptyConfig.logo).toBeUndefined();
    expect(emptyConfig.favicon).toBeUndefined();

    const dark = await project({
      "docs.json": JSON.stringify({
        name: "Dark",
        styling: { codeblocks: { theme: "dark" } },
      }),
    });
    const darkConfig = await loadMintlifyConfig(dark, join(dark, "docs.json"));
    expect(darkConfig.markdown?.codeBlocks?.theme).toEqual({
      dark: "github-dark",
      light: "github-dark",
    });

    const both = await project({
      "docs.json": JSON.stringify({
        name: "Both",
        styling: {
          codeblocks: { theme: { dark: "nord", light: "min-light" } },
        },
      }),
    });
    const bothConfig = await loadMintlifyConfig(both, join(both, "docs.json"));
    expect(bothConfig.markdown?.codeBlocks?.theme).toEqual({
      dark: "nord",
      light: "min-light",
    });

    const invalid = await project({
      "docs.json": JSON.stringify({
        name: "Invalid",
        styling: { codeblocks: { theme: true } },
      }),
    });
    const invalidConfig = await loadMintlifyConfig(
      invalid,
      join(invalid, "docs.json")
    );
    expect(invalidConfig.markdown?.codeBlocks).toBeUndefined();

    const blankTheme = await project({
      "docs.json": JSON.stringify({
        name: "BlankTheme",
        styling: { codeblocks: { theme: {} } },
      }),
    });
    const blankConfig = await loadMintlifyConfig(
      blankTheme,
      join(blankTheme, "docs.json")
    );
    expect(blankConfig.markdown?.codeBlocks).toBeUndefined();
  });
});

describe("loadMintlifyConfig $ref and error handling", () => {
  it("resolves $ref pointers, merging siblings and inlining arrays", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        footer: { $ref: "./footer.json", socials: { x: "https://x.example" } },
        name: "Refs",
        navigation: { $ref: "./nav.json" },
        redirects: { $ref: "./redirects.json" },
      }),
      "footer.json": JSON.stringify({
        links: [{ header: "H", items: [{ href: "/h", label: "L" }] }],
      }),
      "nav.json": JSON.stringify({
        pages: [{ group: "G", pages: ["g/a"] }],
      }),
      "redirects.json": JSON.stringify([{ destination: "/b", source: "/a" }]),
    });

    const config = await loadMintlifyConfig(root, join(root, "docs.json"));
    expect(config.redirects).toContainEqual({ from: "/a", to: "/b" });
    expect(JSON.stringify(config.navigation?.sidebar)).toContain("g/a");
  });

  it("rejects a $ref that points outside the project root", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        name: "Escape",
        navigation: { $ref: "../escape.json" },
      }),
    });
    await expect(
      loadMintlifyConfig(root, join(root, "docs.json"))
    ).rejects.toThrow("points outside the project root");
  });

  it("rejects a cyclic $ref chain", async () => {
    const root = await project({
      "a.json": JSON.stringify({ $ref: "./b.json" }),
      "b.json": JSON.stringify({ $ref: "./a.json" }),
      "docs.json": JSON.stringify({
        name: "Cycle",
        navigation: { $ref: "./a.json" },
      }),
    });
    await expect(
      loadMintlifyConfig(root, join(root, "docs.json"))
    ).rejects.toThrow("cycle detected");
  });

  it("rejects an unparseable config", async () => {
    const root = await project({ "docs.json": "{ not valid" });
    await expect(
      loadMintlifyConfig(root, join(root, "docs.json"))
    ).rejects.toThrow("Could not parse Mintlify config");
  });

  it("rejects a non-object config", async () => {
    const root = await project({ "docs.json": "[]" });
    await expect(
      loadMintlifyConfig(root, join(root, "docs.json"))
    ).rejects.toThrow("must be a JSON object");
  });
});

describe("mintlifyI18n", () => {
  it("returns null when fewer than two languages are configured", () => {
    expect(mintlifyI18n({})).toBeNull();
    expect(
      mintlifyI18n({ navigation: { languages: [{ language: "en" }] } })
    ).toBeNull();
  });

  it("maps languages to locales with native labels", () => {
    const i18n = mintlifyI18n({
      navigation: {
        languages: [
          { language: "fr" },
          { default: true, language: "en" },
          { language: "a" },
          { language: "xx" },
        ],
      },
    });
    expect(i18n?.defaultLocale).toBe("en");
    expect(i18n?.locales).toContainEqual({ code: "fr", label: "Français" });
    expect(i18n?.locales).toContainEqual({ code: "a", label: "a" });
    expect(i18n?.locales).toContainEqual({ code: "xx", label: "xx" });
  });

  it("falls back to the first language, then to en", () => {
    expect(
      mintlifyI18n({
        navigation: { languages: [{ language: "de" }, { language: "es" }] },
      })?.defaultLocale
    ).toBe("de");
    expect(
      mintlifyI18n({ navigation: { languages: [{}, {}] } })?.defaultLocale
    ).toBe("en");
  });
});

describe("rewriteMintlifySvgIconProps edge cases", () => {
  it("unwraps a parenthesized SVG expression and aliases JSX attributes", () => {
    const out = rewriteMintlifySvgIconProps(
      '<Icon icon={(<svg className="i" fillRule="evenodd"><path strokeWidth={2} /></svg>)} />'
    );
    expect(out).toContain('icon={"');
    expect(out).not.toContain("className");
    expect(out).not.toContain("fillRule");
    expect(out).toContain("fill-rule");
    expect(out).toContain("stroke-width");
  });

  it("leaves a non-SVG icon expression untouched", () => {
    const input = "<Icon icon={someVariable} />";
    expect(rewriteMintlifySvgIconProps(input)).toBe(input);
  });

  it("leaves a malformed SVG-ish expression untouched", () => {
    const input = "<Icon icon={<svg foo} />";
    expect(rewriteMintlifySvgIconProps(input)).toBe(input);
  });

  it("stops at an unterminated icon expression", () => {
    const input = "before <Icon icon={<svg unterminated";
    expect(rewriteMintlifySvgIconProps(input)).toBe(input);
  });
});

describe("normalizeMintlifyPageMeta edge cases", () => {
  it("returns the value unchanged when it is not a valid meta object", () => {
    expect(normalizeMintlifyPageMeta(null)).toEqual({});
    expect(normalizeMintlifyPageMeta("frontmatter") as unknown).toBe(
      "frontmatter"
    );
    expect(normalizeMintlifyPageMeta({ hidden: "not-a-boolean" })).toEqual({
      hidden: "not-a-boolean",
    });
  });
});

describe("snippet inlining edge cases", () => {
  it("ignores markdown snippet imports resolving outside the root", async () => {
    const out = await rewriteMintlifyMarkdownSnippets(
      'import X from "../outside.mdx";\n\n<X />\n',
      { filePath: "/proj/page.mdx", root: "/proj" }
    );
    expect(out).toContain('import X from "../outside.mdx";');
  });

  it("detects circular markdown snippet imports", async () => {
    const files: Record<string, string> = {
      "/proj/snippets/a.mdx": 'import B from "/snippets/b.mdx";\n\n<B />\n',
      "/proj/snippets/b.mdx": 'import A from "/snippets/a.mdx";\n\n<A />\n',
    };
    await expect(
      rewriteMintlifyMarkdownSnippets(
        'import A from "/snippets/a.mdx";\n\n<A />\n',
        {
          filePath: "/proj/page.mdx",
          readFile: (file) => Promise.resolve(files[file] ?? ""),
          root: "/proj",
        }
      )
    ).rejects.toThrow("Circular Mintlify snippet import detected");
  });

  it("ignores variable imports resolving outside the root", async () => {
    const out = await rewriteMintlifySnippetVariables(
      'import { greeting } from "../out.mdx";\n\n{greeting}\n',
      { filePath: "/proj/page.mdx", root: "/proj" }
    );
    expect(out).toContain("{greeting}");
  });

  it("skips empty named variable imports", async () => {
    const out = await rewriteMintlifySnippetVariables(
      'import {  } from "/snippets/v.mdx";\n\nbody\n',
      {
        filePath: "/proj/page.mdx",
        readFile: () => Promise.resolve(""),
        root: "/proj",
      }
    );
    expect(out).toContain("body");
  });
});

describe("migrateMintlify config and asset variants", () => {
  it("relocates a string logo and an object favicon into public/", async () => {
    const root = await project({
      "brand/logo.svg": "<svg/>",
      "docs.json": JSON.stringify({
        favicon: { dark: "/fav/dark.svg", light: "/fav/light.svg" },
        logo: "/brand/logo.svg",
        name: "Logo Docs",
        navigation: { pages: ["index"] },
      }),
      "fav/dark.svg": "<svg/>",
      "fav/light.svg": "<svg/>",
      "index.mdx": "---\ntitle: Home\n---\n\nHello\n",
    });

    const result = await migrateMintlify(root);
    expect(existsSync(join(root, "public", "brand", "logo.svg"))).toBe(true);
    expect(existsSync(join(root, "public", "fav", "light.svg"))).toBe(true);
    expect(existsSync(join(root, "public", "fav", "dark.svg"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("public/"))).toBe(true);
  });

  it("maps two or more languages to i18n and drops the language selector", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        name: "Localized",
        navigation: {
          languages: [
            { default: true, language: "en", pages: ["en/index"] },
            { language: "fr", pages: ["fr/index"] },
          ],
        },
      }),
      "en/index.mdx": "---\ntitle: Home\n---\n\nHello\n",
      "fr/index.mdx": "---\ntitle: Accueil\n---\n\nBonjour\n",
    });

    const result = await migrateMintlify(root);
    const config = await readFile(join(root, "blume.config.ts"), "utf-8");
    expect(config).toContain('"defaultLocale": "en"');
    expect(config).not.toContain('"kind": "language"');
    expect(
      result.warnings.some((w) => w.includes("languages to i18n.locales"))
    ).toBe(true);
  });

  it("writes a default config when no docs.json or mint.json exists", async () => {
    const root = await project({
      "index.mdx": "---\ntitle: Home\n---\n\nHello\n",
    });

    const result = await migrateMintlify(root);
    const config = await readFile(join(root, "blume.config.ts"), "utf-8");
    expect(config).toContain('"title": "Documentation"');
    expect(
      result.warnings.some((w) => w.includes("No docs.json or mint.json found"))
    ).toBe(true);
  });

  it("reports components without a Blume equivalent", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        name: "API",
        navigation: { pages: ["index"] },
      }),
      "index.mdx":
        '---\ntitle: Home\n---\n\n<ParamField name="id" type="string" />\n',
    });

    const result = await migrateMintlify(root);
    expect(result.warnings.some((w) => w.includes("ParamField"))).toBe(true);
  });
});
