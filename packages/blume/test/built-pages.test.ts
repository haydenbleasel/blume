import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  agentPages,
  builtMirrorRoutes,
  pageTitle,
  readBuiltPage,
  readBuiltPages,
} from "../src/ai/built-pages.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { publishBuildArtifacts } from "../src/deploy/artifacts.ts";
import { customMirrorName, ogTypeFor } from "../src/seo/page-kind.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

interface PageHtml {
  description?: string;
  head?: string;
  jsonLd?: string[];
  main?: string;
  mainAttributes?: string;
  robots?: string;
  title?: string | null;
}

/** A built page as PageLayout renders one: head tags, chrome, and `<main>`. */
const pageHtml = ({
  description,
  head = "",
  jsonLd = [],
  main = "<h1>Pricing</h1><p>Plans.</p>",
  mainAttributes = 'id="blume-content"',
  robots,
  title = "Pricing — Acme",
}: PageHtml = {}): string =>
  [
    "<!doctype html><html><head>",
    title === null ? "" : `<title>${title}</title>`,
    description ? `<meta content="${description}" name="description">` : "",
    robots ? `<meta content="${robots}" name="robots">` : "",
    ...jsonLd.map(
      (script) => `<script type="application/ld+json">${script}</script>`
    ),
    head,
    "</head><body><header><a href='/'>Acme</a></header>",
    `<main ${mainAttributes}>${main}</main>`,
    "<footer>© Acme</footer></body></html>",
  ].join("");

/** The Markdown a page with this `<main>` content converts to. */
const markdownOf = (main: string): string =>
  readBuiltPage(pageHtml({ main }), "/pricing", "Acme").document?.markdown ??
  "";

describe("readBuiltPage", () => {
  it("converts the content landmark to Markdown, leaving the chrome out", () => {
    const page = readBuiltPage(
      pageHtml({
        description: "Plans for every team.",
        main: [
          '<h2 id="plans"><a class="blume-heading-anchor" href="#plans">Plans</a></h2>',
          '<p>Read the <a href="/docs">docs</a>.</p>',
          "<!-- a comment -->",
          "<ul><li>Free</li><li>Team</li></ul>",
          "<table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Free</td><td>$0</td></tr></tbody></table>",
          '<pre data-language="ts"><code><span>const a = 1;</span></code></pre>',
          "<pre><code>plain</code></pre>",
          '<pre data-language="sh">echo bare</pre>',
          '<img alt="A diagram" src="/diagram.png">',
          '<img alt="" src="/decoration.png">',
          "<script>track()</script><style>p{}</style><svg><text>icon</text></svg>",
          "<button>Copy</button><nav><a href='/'>Home</a></nav>",
          "<form><input value='q'><select><option>One</option></select><textarea>Draft</textarea></form>",
          "<p hidden>Hidden.</p><p aria-hidden='true'>Decor.</p><p inert>Inert.</p>",
          '<div data-blume-visibility="web"><p>Sign up today.</p></div>',
          '<div data-blume-visibility="agents" hidden><p>Agents only.</p></div>',
        ].join(""),
      }),
      "/pricing",
      "Acme"
    );
    expect(page.noindex).toBe(false);
    expect(page.document?.title).toBe("Pricing");
    expect(page.document?.description).toBe("Plans for every team.");
    const markdown = page.document?.markdown ?? "";
    expect(markdown).toStartWith("## Plans\n\nRead the [docs](/docs).");
    expect(markdown).toContain("- Free\n- Team");
    expect(markdown).toContain("| Plan | Price |");
    expect(markdown).toContain("```ts\nconst a = 1;\n```");
    expect(markdown).toContain("```\nplain\n```");
    expect(markdown).toContain("echo bare");
    expect(markdown).toContain("![A diagram](/diagram.png)");
    expect(markdown).toContain("Agents only.");
    for (const left of [
      "decoration",
      "track()",
      "icon",
      "Copy",
      "Home",
      "Draft",
      "Hidden.",
      "Decor.",
      "Inert.",
      "Sign up",
      "comment",
      "© Acme",
    ]) {
      expect(markdown).not.toContain(left);
    }
  });

  it("spaces neighboring elements that would read as one word", () => {
    // Astro's compressHTML drops the whitespace CSS stood in for.
    expect(
      markdownOf(
        '<p><span>Claude Code by Anthropic</span><span aria-hidden="true">·</span><span>Checked against October 2026</span></p>'
      )
    ).toBe("Claude Code by Anthropic Checked against October 2026");
    expect(
      markdownOf(
        "<ol><li><span>1</span><span><span><code>CLAUDE.md</code></span><span>Your notes.</span></span></li></ol>"
      )
    ).toBe("1. 1 `CLAUDE.md` Your notes.");
    expect(
      markdownOf(
        '<a href="/agents/codex"><span>Agent</span><span>Codex</span><span>OpenAI’s agent</span></a>'
      )
    ).toBe("[Agent Codex OpenAI’s agent](/agents/codex)");
    expect(
      markdownOf(
        '<p><span>Also on</span><a href="/b">Biome</a><a href="/e">ESLint</a><br><img alt="Oxlint" src="/o.svg"><span>1.94</span></p>'
      )
    ).toBe("Also on [Biome](/b) [ESLint](/e)\\\n![Oxlint](/o.svg) 1.94");
  });

  it("leaves prose, punctuation, and code spacing as written", () => {
    // Text beside an element is the author's spacing.
    expect(
      markdownOf('<p>Run<code>init</code>, then <a href="/x">check</a>.</p>')
    ).toBe("Run`init`, then [check](/x).");
    // Closing punctuation, a space already there, or an empty side.
    expect(
      markdownOf(
        "<p><span>(see</span><span>)</span><span>done</span><span>.</span><span>a </span><span>b</span><span></span><span>c</span></p>"
      )
    ).toBe("(see) done. a b c");
    // Nothing inside code changes.
    expect(
      markdownOf(
        '<p><code><span>a</span><span>b</span></code></p><pre data-language="ts"><code><span>x</span><span>y</span></code></pre>'
      )
    ).toBe("`ab`\n\n```ts\nxy\n```");
  });

  it("dates the page from the JSON-LD node that describes it", () => {
    const graph = JSON.stringify({
      "@graph": [
        { dateModified: "2020-01-01", url: "https://acme.dev/elsewhere" },
        { url: 42 },
        { dateModified: "not a date", url: "https://acme.dev/pricing" },
        { dateModified: "2026-03-04", url: "https://acme.dev/pricing/" },
      ],
    });
    expect(
      readBuiltPage(
        pageHtml({ jsonLd: ["{not json", '"a string"', graph] }),
        "/pricing",
        "Acme"
      ).lastModified
    ).toBe("2026-03-04T00:00:00.000Z");
    // A node may name the page through `mainEntityOfPage`, as a URL or as a
    // node with an `@id`, and a script may be an array of nodes.
    const entity = JSON.stringify([
      {
        dateModified: "2026-05-06",
        mainEntityOfPage: { "@id": "https://acme.dev/pricing" },
      },
    ]);
    expect(
      readBuiltPage(pageHtml({ jsonLd: [entity] }), "/pricing", "Acme")
        .lastModified
    ).toBe("2026-05-06T00:00:00.000Z");
    const bare = JSON.stringify({
      dateModified: "2026-07-08",
      mainEntityOfPage: "/pricing",
    });
    expect(
      readBuiltPage(pageHtml({ jsonLd: [bare] }), "/pricing", "Acme")
        .lastModified
    ).toBe("2026-07-08T00:00:00.000Z");
  });

  it("falls back to article:modified_time, then to no date", () => {
    const meta =
      '<meta content="2026-09-10T11:00:00Z" property="article:modified_time">';
    expect(
      readBuiltPage(pageHtml({ head: meta }), "/pricing", "Acme").lastModified
    ).toBe("2026-09-10T11:00:00.000Z");
    expect(
      readBuiltPage(pageHtml(), "/pricing", "Acme").lastModified
    ).toBeUndefined();
  });

  it("keeps a noindex or web-only page off the agent surfaces", () => {
    const noindex = readBuiltPage(
      pageHtml({ robots: "NoIndex, nofollow" }),
      "/pricing",
      "Acme"
    );
    expect(noindex.noindex).toBe(true);
    expect(noindex.document).toBeUndefined();
    const excluded = readBuiltPage(
      pageHtml({
        mainAttributes: 'data-blume-visibility="web" id="blume-content"',
      }),
      "/pricing",
      "Acme"
    );
    expect(excluded.noindex).toBe(false);
    expect(excluded.document).toBeUndefined();
  });

  it("needs Blume's content landmark, and skips it when asked to", () => {
    expect(
      readBuiltPage(pageHtml({ mainAttributes: "" }), "/pricing", "Acme")
        .document
    ).toBeUndefined();
    expect(
      readBuiltPage(pageHtml(), "/pricing", "Acme", false).document
    ).toBeUndefined();
  });

  it("titles an untitled page by its route", () => {
    expect(
      readBuiltPage(pageHtml({ title: null }), "/pricing", "Acme").document
        ?.title
    ).toBe("/pricing");
  });
});

describe("pageTitle", () => {
  it("drops a trailing segment that names the site", () => {
    expect(pageTitle("Type imports — Acme Research", "Acme")).toBe(
      "Type imports"
    );
    expect(pageTitle("Pricing | Acme", "Acme")).toBe("Pricing");
    expect(pageTitle("Setup - Acme", "Acme")).toBe("Setup");
  });

  it("keeps a title whose last segment is about the page", () => {
    expect(pageTitle("Acme for Oxlint — Strict config", "Acme")).toBe(
      "Acme for Oxlint — Strict config"
    );
    expect(pageTitle("  Acme  ", "Acme")).toBe("Acme");
    expect(pageTitle("Pricing — Acme", "")).toBe("Pricing — Acme");
  });
});

describe("page-kind", () => {
  it("makes dated writing an article", () => {
    expect(ogTypeFor("blog")).toBe("article");
    expect(ogTypeFor("changelog")).toBe("article");
    expect(ogTypeFor("doc")).toBe("website");
    expect(ogTypeFor()).toBe("website");
  });

  it("names the Markdown copy of every static page that joins the surfaces", () => {
    const page = {
      dynamic: false,
      excluded: false,
      noindex: false,
      route: "/pricing",
    };
    expect(customMirrorName(page)).toBe("/pricing");
    expect(customMirrorName({ ...page, noindex: true, route: "/" })).toBe(
      "/index"
    );
    expect(customMirrorName({ ...page, dynamic: true })).toBeNull();
    expect(customMirrorName({ ...page, excluded: true })).toBeNull();
    expect(customMirrorName({ ...page, noindex: true })).toBeNull();
    expect(customMirrorName({ ...page, route: "/404" })).toBeNull();
  });
});

/** A project on disk plus its build output, with the given built HTML. */
const fixture = async (
  files: Record<string, string>,
  built: Record<string, string> = {}
): Promise<{ dist: string; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "blume-built-pages-"));
  dirs.push(root);
  const dist = join(root, "dist");
  await Promise.all(
    [
      ...Object.entries(files).map(([path, content]) => ({
        content,
        target: join(root, path),
      })),
      ...Object.entries(built).map(([path, content]) => ({
        content,
        target: join(dist, path),
      })),
    ].map(async ({ content, target }) => {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    })
  );
  await mkdir(dist, { recursive: true });
  return { dist, root };
};

const PAGE = "---\nfoo: bar\n---\n<h1>Page</h1>\n";

describe("readBuiltPages", () => {
  it("reads every static custom page Astro wrote, and the changelog index's date", async () => {
    const { dist, root } = await fixture(
      {
        "blume.config.ts": "export default { title: 'Acme' };\n",
        "docs/guide.md": "---\ntitle: Guide\n---\n# Guide\n",
        "docs/releases/v1.md":
          "---\ntitle: v1\ntype: changelog\ndate: 2026-01-02\n---\n\nFirst.\n",
        "pages/404.astro": PAGE,
        "pages/about.astro": PAGE,
        "pages/blog/[slug].astro": PAGE,
        "pages/guide.astro": PAGE,
        "pages/index.astro": PAGE,
        "pages/pricing.astro": PAGE,
      },
      {
        "404/index.html": pageHtml(),
        "changelog/index.html": pageHtml({
          head: '<meta content="2026-01-02T00:00:00Z" property="article:modified_time">',
        }),
        "guide/index.html": pageHtml(),
        "index.html": pageHtml({ title: "Acme" }),
        "pricing/index.html": pageHtml(),
      }
    );
    const project = await scanProject(root, { mode: "build" });
    const pages = await readBuiltPages(project, dist);
    // `/about` has no HTML; `/404`, the dynamic route, and `/guide` (a
    // content route) are never read.
    expect(pages.map((page) => page.route).toSorted()).toEqual([
      "/",
      "/changelog",
      "/pricing",
    ]);
    const byRoute = new Map(pages.map((page) => [page.route, page]));
    // The homepage and the changelog index keep their own mirrors.
    expect(byRoute.get("/")?.document).toBeUndefined();
    expect(byRoute.get("/changelog")?.document).toBeUndefined();
    expect(byRoute.get("/changelog")?.lastModified).toBe(
      "2026-01-02T00:00:00.000Z"
    );
    expect(agentPages(pages).map((page) => page.route)).toEqual(["/pricing"]);
  });

  it("matches a page's JSON-LD under the deployment base", async () => {
    const dated = JSON.stringify({
      dateModified: "2026-02-03",
      url: "https://acme.dev/docs/pricing",
    });
    const { dist, root } = await fixture(
      {
        "blume.config.ts":
          'export default { deployment: { site: "https://acme.dev", base: "/docs" } };\n',
        "docs/guide.md": "---\ntitle: Guide\n---\n# Guide\n",
        "pages/pricing.astro": PAGE,
      },
      { "pricing/index.html": pageHtml({ jsonLd: [dated] }) }
    );
    const project = await scanProject(root, { mode: "build" });
    const [page] = await readBuiltPages(project, dist);
    expect(page?.lastModified).toBe("2026-02-03T00:00:00.000Z");
  });

  it("reads nothing without a pages folder", async () => {
    const { dist, root } = await fixture({
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const project = await scanProject(root, { mode: "build" });
    expect(await readBuiltPages(project, dist)).toEqual([]);
    expect(builtMirrorRoutes(project, dist)).toEqual([]);
  });
});

/** Publish the build artifacts for `root` into `dist`; returns the info log. */
const publish = async (root: string, dist: string): Promise<string[]> => {
  const info: string[] = [];
  const project = await scanProject(root, { mode: "build" });
  await publishBuildArtifacts(
    project,
    dist,
    { info: (message) => info.push(message), warn: () => {} },
    async () => await Promise.resolve(0)
  );
  return info;
};

describe("custom pages in the build artifacts", () => {
  it("writes Markdown copies, lists the pages for agents, and dates them in the sitemap", async () => {
    const dated = JSON.stringify({
      dateModified: "2026-04-05",
      url: "https://acme.dev/providers/oxlint",
    });
    const { dist, root } = await fixture(
      {
        "blume.config.ts":
          'export default { title: "Acme", deployment: { site: "https://acme.dev" }, navigation: { tabs: [{ label: "Docs", path: "/docs" }, { label: "Providers", path: "/providers" }] } };\n',
        "docs/docs/index.md": "---\ntitle: Intro\n---\n# Intro\n",
        "pages/hidden.astro": PAGE,
        "pages/providers/index.astro": PAGE,
        "pages/providers/oxlint.astro": PAGE,
        "pages/secret.astro": PAGE,
        "public/providers.md": "mine",
      },
      {
        "hidden/index.html": pageHtml({ robots: "noindex" }),
        "providers.md": "mine\n",
        "providers/index.html": pageHtml({ title: "Providers — Acme" }),
        "providers/oxlint/index.html": pageHtml({
          description: "The fast one.",
          jsonLd: [dated],
          main: "<h1>Oxlint</h1><p>Rust.</p>",
          title: "Acme for Oxlint — Strict config",
        }),
        "secret/index.html": pageHtml({
          mainAttributes: 'data-blume-visibility="web" id="blume-content"',
        }),
      }
    );
    const info = await publish(root, dist);
    expect(info).toContain(
      "Wrote Markdown copies of 2 custom page(s) for agents"
    );
    // Both copies of each page, beside its HTML; a file already there wins.
    expect(await readFile(join(dist, "providers/oxlint.md"), "utf-8")).toBe(
      "# Oxlint\n\nRust.\n"
    );
    expect(existsSync(join(dist, "providers/oxlint.mdx"))).toBe(true);
    expect(await readFile(join(dist, "providers.md"), "utf-8")).toBe("mine\n");
    expect(existsSync(join(dist, "providers.mdx"))).toBe(true);
    // No copy of a noindex or excluded page.
    expect(existsSync(join(dist, "hidden.md"))).toBe(false);
    expect(existsSync(join(dist, "secret.md"))).toBe(false);

    const index = await readFile(join(dist, "llms.txt"), "utf-8");
    expect(index).toContain(
      [
        "## Providers",
        "",
        "- [Providers](https://acme.dev/providers)",
        "- [Acme for Oxlint — Strict config](https://acme.dev/providers/oxlint): The fast one.",
      ].join("\n")
    );
    const full = await readFile(join(dist, "llms-full.txt"), "utf-8");
    expect(full).toContain(
      "# Acme for Oxlint — Strict config\nSource: https://acme.dev/providers/oxlint\n\n# Oxlint\n\nRust."
    );

    const sitemap = await readFile(join(dist, "sitemap.xml"), "utf-8");
    expect(sitemap).toContain(
      "<loc>https://acme.dev/providers/oxlint</loc><lastmod>2026-04-05</lastmod>"
    );
    expect(sitemap).toContain("<loc>https://acme.dev/providers</loc></url>");
    expect(sitemap).toContain("<loc>https://acme.dev/secret</loc>");
    expect(sitemap).not.toContain("https://acme.dev/hidden");

    // The negotiation surfaces serve the pages a copy was written for.
    const project = await scanProject(root, { mode: "build" });
    expect(builtMirrorRoutes(project, dist).toSorted()).toEqual([
      "/providers",
      "/providers/oxlint",
    ]);
  });

  it("writes nothing new when every copy is already there", async () => {
    const { dist, root } = await fixture(
      {
        "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
        "pages/pricing.astro": PAGE,
      },
      {
        "pricing.md": "mine\n",
        "pricing.mdx": "mine\n",
        "pricing/index.html": pageHtml(),
      }
    );
    const info = await publish(root, dist);
    expect(info.some((line) => line.startsWith("Wrote Markdown copies"))).toBe(
      false
    );
    expect(await readFile(join(dist, "pricing.md"), "utf-8")).toBe("mine\n");
  });
});
