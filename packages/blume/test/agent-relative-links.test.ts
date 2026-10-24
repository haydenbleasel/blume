import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildAskData } from "../src/ai/ask-data.ts";
import { buildLlmsFiles } from "../src/ai/llms.ts";
import { buildRawMarkdown } from "../src/ai/markdown.ts";
import { relativeLinkRewriter } from "../src/ai/relative-links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scanFixture = async (
  files: Record<string, string>
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-agent-links-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return await scanProject(root);
};

const GUIDES_INDEX = [
  "---",
  "title: Guides",
  "---",
  "",
  "Start with [Install](./install), then [Setup](setup.md#config).",
  "Back [home](../index.md), or [elsewhere](https://example.com/x).",
  "![Diagram](./diagram.png) and `[shown](./install)` stay as written.",
  "",
  "```md",
  "[inside a fence](./install)",
  "```",
  "",
  "[ref]: ./install",
  "[angled]: <./setup.md>",
  "",
].join("\n");

const FILES = {
  "blume.config.ts": 'export default { deployment: { base: "/sub" } };',
  "docs/guides/index.md": GUIDES_INDEX,
  "docs/guides/install.md": "# Install\n",
  "docs/guides/leaf.md": "# Leaf\n\nSee [Install](./install).\n",
  "docs/guides/setup.md": "---\nslug: guides/configure\n---\n# Setup\n",
  "docs/index.md": "# Home\n",
};

/** A staged source entry, as a remote source loads it. */
const entry = (ref: string, title: string, text: string) => ({
  body: { format: "md", text },
  data: { title },
  ref,
});

describe("relative page links on the agent surfaces", () => {
  it("points each at the route it means in the Markdown mirrors", async () => {
    const project = await scanFixture(FILES);
    const raw = await buildRawMarkdown(project);
    const guides = raw["/guides"]?.mdx ?? "";
    // An index page's links resolve inside its folder; a `.md` link lands on
    // the route that file publishes at, its own `slug` included.
    expect(guides).toContain(
      "Start with [Install](/sub/guides/install), then [Setup](/sub/guides/configure#config)."
    );
    expect(guides).toContain(
      "Back [home](/sub), or [elsewhere](https://example.com/x)."
    );
    expect(guides).toContain(
      "![Diagram](./diagram.png) and `[shown](./install)` stay as written."
    );
    expect(guides).toContain("```md\n[inside a fence](./install)\n```");
    expect(guides).toContain("[ref]: /sub/guides/install");
    expect(guides).toContain("[angled]: </sub/guides/configure>");
    // A leaf page's links resolve against its parent folder.
    expect(raw["/guides/leaf"]?.mdx).toContain(
      "See [Install](/sub/guides/install)."
    );
  });

  it("rewrites them in llms-full.txt", async () => {
    const project = await scanFixture(FILES);
    const { full } = await buildLlmsFiles(project);
    expect(full).toContain("Start with [Install](/sub/guides/install)");
    expect(full).toContain("See [Install](/sub/guides/install).");
  });

  it("returns a page with no relative link untouched, skipping the parse", async () => {
    const project = await scanFixture(FILES);
    const rewrite = relativeLinkRewriter(project);
    const page = {
      route: "/guides/leaf",
      sourcePath: project.graph.pages[0]?.sourcePath,
    };
    const text =
      "See [docs](https://example.com), [top](#intro), and [mail](mailto:a@b.c).\n\n[ref]: https://example.com/x\n";
    expect(rewrite(text, page)).toBe(text);
    // A relative target anywhere still takes the full path.
    expect(rewrite("[x](install)", page)).not.toBe("[x](install)");
  });

  it("rewrites dotted page names and component hrefs, not assets", async () => {
    const project = await scanFixture({
      "docs/guides/index.mdx": [
        "# Guides",
        "",
        "See [Node](./node.js) and [the diagram](./diagram.png).",
        "",
        '<Card title="Install" href="./install" />',
        "",
      ].join("\n"),
      "docs/guides/install.md": "# Install\n",
      "docs/guides/node.js.mdx": "# Node\n",
    });
    const raw = await buildRawMarkdown(project);
    const guides = raw["/guides"]?.mdx ?? "";
    expect(guides).toContain("See [Node](/guides/node.js)");
    expect(guides).toContain("[the diagram](./diagram.png)");
    expect(guides).toContain('<Card title="Install" href="/guides/install" />');
  });

  it("rewrites an escaped or angle-bracketed target in place", async () => {
    // The target is read as the renderer reads it (`\_` is `_`), and the
    // route replaces exactly what was written, inside any `<…>`.
    const project = await scanFixture({
      "docs/guides/index.md": [
        "# Guides",
        "",
        String.raw`See [Set up](./set\_up.md) and [Install](<./install>).`,
        "",
      ].join("\n"),
      "docs/guides/install.md": "# Install\n",
      "docs/guides/set_up.md": "# Set up\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/guides"]?.mdx).toContain(
      "See [Set up](/guides/set_up) and [Install](</guides/install>)."
    );
  });

  it("leaves a .md page's indented code and comments as written", async () => {
    const project = await scanFixture({
      ...FILES,
      "docs/guides/indented.md": [
        "# Indented",
        "",
        "A sample:",
        "",
        "    [sample](./install) [spec](./spec.pdf) ![pic](./pic.png)",
        "",
        "<!-- [spec](./spec.pdf) ![pic](./pic.png) -->",
        "",
        "- An item",
        "",
        "    [in the item](./install) [spec](./spec.pdf)",
        "",
      ].join("\n"),
      "docs/guides/pic.png": "png",
      "docs/guides/spec.pdf": "pdf",
    });
    const raw = await buildRawMarkdown(project);
    const { full } = await buildLlmsFiles(project);
    const served = "/sub/blume-assets/content/docs/guides";
    for (const text of [raw["/guides/indented"]?.mdx ?? "", full]) {
      expect(text).toContain(
        "    [sample](./install) [spec](./spec.pdf) ![pic](./pic.png)\n"
      );
      expect(text).toContain("<!-- [spec](./spec.pdf) ![pic](./pic.png) -->");
      expect(text).toContain(
        `    [in the item](/sub/guides/install) [spec](${served}/spec.pdf)`
      );
    }
  });

  it("reads a sibling a locale hasn't translated from the default tree", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };',
      "docs/fr/guides/index.mdx": "# Guides\n\nSee [Setup](./setup.mdx).\n",
      "docs/guides/index.mdx": "# Guides\n",
      "docs/guides/setup.mdx": "---\nslug: getting-started\n---\n# Setup\n",
    });
    const raw = await buildRawMarkdown(project);
    // The route — its own `slug` included — then moves into the reader's
    // locale, onto the fallback copy, as the rendered page moves it.
    expect(raw["/fr/guides"]?.mdx).toContain(
      "See [Setup](/fr/getting-started)."
    );
  });

  it("reads an untranslated sibling from the reader's own docs version", async () => {
    // An archived version's `navPath` drops its version folder, so it names
    // the same default-tree file as the current page.
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }, versions: { archived: [{ id: "v1.0" }], current: { label: "v2.0" } } };',
      "docs/fr/guides/leaf.md": "# Feuille\n\nVoir [Setup](./setup.md).\n",
      "docs/guides/leaf.md": "# Leaf\n",
      "docs/guides/setup.md": "# Setup\n",
      "docs/v1.0/fr/guides/leaf.md":
        "# Feuille 1.0\n\nVoir [Setup](./setup.md).\n",
      "docs/v1.0/guides/leaf.md": "# Leaf 1.0\n",
      "docs/v1.0/guides/setup.md": "# Setup 1.0\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/fr/guides/leaf"]?.mdx).toContain(
      "Voir [Setup](/fr/guides/setup)."
    );
    expect(raw["/fr/v1.0/guides/leaf"]?.mdx).toContain(
      "Voir [Setup](/fr/v1.0/guides/setup)."
    );
  });

  it("reads a link into another version's untranslated page as the rendered page does", async () => {
    // The link climbs out of the locale folder into an archived version's,
    // which hasn't translated the page either: the rendered page lands on
    // that version's default-tree file, then moves it into the locale.
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }, versions: { archived: [{ id: "v1.0" }], current: { label: "v2.0" } } };',
      "docs/fr/guides/leaf.md":
        "# Feuille\n\nVoir [Setup 1.0](../../v1.0/fr/guides/setup.md).\n",
      "docs/guides/leaf.md": "# Leaf\n",
      "docs/v1.0/guides/setup.md": "---\nslug: configure\n---\n# Setup 1.0\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/fr/guides/leaf"]?.mdx).toContain(
      "Voir [Setup 1.0](/fr/v1.0/configure)."
    );
  });

  it("percent-encodes a route a link destination can't hold as written", async () => {
    // `my page.md` publishes at `/guides/my page`, and a space or a
    // parenthesis would end or split the link.
    const project = await scanFixture({
      ...FILES,
      "docs/guides/leaf.md":
        "# Leaf\n\nSee [mine](./my%20page.md), [again](<./my page.md#a b>) and [notes](./notes%20(old).md).\n",
      "docs/guides/my page.md": "# Mine\n",
      "docs/guides/notes (old).md": "# Notes\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/guides/leaf"]?.mdx).toContain(
      "See [mine](/sub/guides/my%20page), [again](</sub/guides/my%20page#a%20b>) and [notes](/sub/guides/notes%20%28old%29)."
    );
  });

  it("serves a root link to a content file under the deployment base", async () => {
    const project = await scanFixture({
      ...FILES,
      "docs/guides/leaf.md":
        "# Leaf\n\nSee [Setup](/guides/setup.md#run) and [again](/sub/guides/setup.md).\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/guides/leaf"]?.mdx).toContain(
      "See [Setup](/sub/guides/configure#run) and [again](/sub/guides/configure)."
    );
  });

  it("moves a root link to a content file into the page's locale", async () => {
    // As the rendered page moves it; the assistant reads the French page,
    // or the default one where a fallback copy stands in.
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };',
      "docs/fr/guides/leaf.md":
        "# Feuille\n\nVoir [Setup](/guides/setup.md) et [Install](/guides/install.md).\n",
      "docs/fr/guides/setup.md": "# Configurer\n",
      "docs/guides/install.md": "# Install\n",
      "docs/guides/setup.md": "# Setup\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/fr/guides/leaf"]?.mdx).toContain(
      "Voir [Setup](/fr/guides/setup) et [Install](/fr/guides/install)."
    );
    const { documents } = await buildAskData(project);
    expect(
      documents.find((doc) => doc.route === "/fr/guides/leaf")?.content
    ).toContain(
      "Voir [Setup](/fr/guides/setup) et [Install](/guides/install)."
    );
  });

  it("lands a root-relative link to a content file on its page", async () => {
    const project = await scanFixture({
      "docs/guides/index.md": [
        "# Guides",
        "",
        "See [Setup](/guides/setup.md#run) and [the copy](/guides/gone.md).",
        "",
        '<a href="/guides/setup.md">Raw</a>',
        "",
      ].join("\n"),
      "docs/guides/setup.md": "---\nslug: guides/configure\n---\n# Setup\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/guides"]?.mdx).toContain(
      "See [Setup](/guides/configure#run) and [the copy](/guides/gone.md)."
    );
    // A raw `<a href>` keeps it, as the rendered page does.
    expect(raw["/guides"]?.mdx).toContain('<a href="/guides/setup.md">Raw</a>');
  });

  it("rewrites them in the assistant's grounding, without the deployment base", async () => {
    // The chat panel mounts the links it renders under `deployment.base`. A
    // root link to a content file lands on its page there too, read with the
    // base or without it, and a root page link keeps its route.
    const project = await scanFixture({
      ...FILES,
      "docs/guides/cards.mdx": '# Cards\n\n<Card href="./install" />\n',
      "docs/guides/rooted.md":
        "# Rooted\n\nSee [Install](/guides/install), [Setup](/guides/setup.md#run) and [it again](/sub/guides/setup.md).\n",
    });
    const { documents } = await buildAskData(project);
    const content = (route: string) =>
      documents.find((doc) => doc.route === route)?.content;
    expect(content("/guides/leaf")).toContain(
      "See [Install](/guides/install)."
    );
    expect(content("/guides/rooted")).toContain(
      "See [Install](/guides/install), [Setup](/guides/configure#run) and [it again](/guides/configure)."
    );
    // The link is rewritten before the card downlevels, so the label the
    // card takes from its `href` is the route too, as in llms-full.txt.
    expect(content("/guides/cards")).toContain(
      "**[/guides/install](/guides/install)**"
    );
    expect(documents.some((doc) => doc.content.includes("/sub/"))).toBe(false);
  });

  it("takes the base off before a query or fragment in the assistant's snapshot", async () => {
    const project = await scanFixture({
      ...FILES,
      "docs/guides/leaf.md":
        "# Leaf\n\nSee [home](/sub#top) and [search](/sub?q=x).\n",
    });
    const { documents } = await buildAskData(project);
    expect(
      documents.find((doc) => doc.route === "/guides/leaf")?.content
    ).toContain("See [home](/#top) and [search](/?q=x).");
  });

  it("leaves a link alone that the base stands between this site and another", async () => {
    // Without the base, `/sub//host/x` reads as another site's link.
    const project = await scanFixture({
      ...FILES,
      "docs/guides/leaf.md": "# Leaf\n\nSee [it](/sub//evil.example/x).\n",
    });
    const { documents } = await buildAskData(project);
    expect(
      documents.find((doc) => doc.route === "/guides/leaf")?.content
    ).toContain("See [it](/sub//evil.example/x).");
  });

  it("points them at the pages the assistant's snapshot holds", async () => {
    // Routes carry basePath but no deployment base. An untranslated sibling
    // is the default tree's page, which the snapshot holds, however the link
    // names it; its French fallback copy isn't in the snapshot.
    const project = await scanFixture({
      "blume.config.ts": `export default {
  basePath: "/docs",
  deployment: { base: "/sub" },
  i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
};`,
      "docs/fr/guides/leaf.md":
        "# Feuille\n\nVoir [Install](./install), [le fichier](./install.md#run) et [Setup](./setup).\n",
      "docs/fr/guides/setup.md": "# Configurer\n",
      "docs/guides/install.md": "# Install\n",
      "docs/guides/leaf.md": "# Leaf\n\nSee [Install](./install).\n",
      "docs/guides/setup.md": "# Setup\n",
    });
    const { documents } = await buildAskData(project);
    const content = (route: string) =>
      documents.find((doc) => doc.route === route)?.content;
    expect(content("/docs/guides/leaf")).toContain(
      "See [Install](/docs/guides/install)."
    );
    expect(content("/docs/fr/guides/leaf")).toContain(
      "Voir [Install](/docs/guides/install), [le fichier](/docs/guides/install#run) et [Setup](/docs/fr/guides/setup)."
    );
    expect(content("/docs/guides/install")).toBeDefined();
    expect(content("/docs/fr/guides/setup")).toBeDefined();
  });

  it("gives the assistant's root page links the basePath and the page's locale", async () => {
    // As the rendered page gives them, without the deployment base the chat
    // panel adds; a link that already carries it is read as including it. A
    // French fallback copy is the page the snapshot holds instead, and
    // images stay as written.
    const project = await scanFixture({
      "blume.config.ts": `export default {
  basePath: "/docs",
  deployment: { base: "/sub" },
  i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
};`,
      "docs/fr/guides/leaf.md":
        "# Feuille\n\nVoir [Install](/guides/install) et [Setup](/guides/setup#run).\n",
      "docs/fr/guides/setup.md": "# Configurer\n",
      "docs/guides/install.md": "# Install\n",
      "docs/guides/leaf.md":
        "# Leaf\n\nSee [Install](/guides/install), [based](/sub/docs/guides/install) and ![logo](/logo.png).\n",
      "docs/guides/setup.md": "# Setup\n",
    });
    const { documents } = await buildAskData(project);
    const content = (route: string) =>
      documents.find((doc) => doc.route === route)?.content;
    expect(content("/docs/guides/leaf")).toContain(
      "See [Install](/docs/guides/install), [based](/docs/guides/install) and ![logo](/logo.png)."
    );
    expect(content("/docs/fr/guides/leaf")).toContain(
      "Voir [Install](/docs/guides/install) et [Setup](/docs/fr/guides/setup#run)."
    );
    // The mirrors serve them where a reader fetches them.
    const raw = await buildRawMarkdown(project);
    expect(raw["/docs/guides/leaf"]?.mdx).toContain(
      "See [Install](/sub/docs/guides/install), [based](/sub/docs/guides/install) and ![logo](/sub/logo.png)."
    );
  });

  it("maps a percent-encoded fallback link onto the page the snapshot holds", async () => {
    // The fallback copies are keyed by their raw routes (`/fr/guides/my page`).
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };',
      "docs/fr/guides/leaf.md":
        "# Feuille\n\nVoir [la page](/guides/my%20page), [encore](./my%20page) et [é](/guides/%C3%A9t%C3%A9), [requête](/guides/my%20page?q=1).\n",
      "docs/guides/my page.md": "# Mine\n",
      "docs/guides/été.md": "# Été\n",
    });
    const { documents } = await buildAskData(project);
    expect(
      documents.find((doc) => doc.route === "/fr/guides/leaf")?.content
    ).toContain(
      "Voir [la page](/guides/my%20page), [encore](/guides/my%20page) et [é](/guides/été), [requête](/guides/my%20page?q=1)."
    );
  });

  it("maps a fallback copy's root link from a default-locale page", async () => {
    // With no base and no locale prefix, the link needs no other change.
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };',
      "docs/guides/leaf.md": "# Leaf\n\nSee [Setup](/fr/guides/setup).\n",
      "docs/guides/setup.md": "# Setup\n",
    });
    const { documents } = await buildAskData(project);
    expect(
      documents.find((doc) => doc.route === "/guides/leaf")?.content
    ).toContain("See [Setup](/guides/setup).");
    // A reader of the mirror is served the copy.
    const raw = await buildRawMarkdown(project);
    expect(raw["/guides/leaf"]?.mdx).toContain(
      "See [Setup](/fr/guides/setup)."
    );
  });

  it("maps a fallback link with a trailing slash onto the page the snapshot holds", async () => {
    // `read_page` reads `/fr/guides/setup/` as `/fr/guides/setup`, a copy the
    // snapshot doesn't hold; other root links need no change.
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };',
      "docs/guides/leaf.md":
        "# Leaf\n\nSee [Setup](/fr/guides/setup/#run), [French](/fr) and [Other](/guides/setup/).\n",
      "docs/guides/setup.md": "# Setup\n",
    });
    const { documents } = await buildAskData(project);
    expect(
      documents.find((doc) => doc.route === "/guides/leaf")?.content
    ).toContain(
      "See [Setup](/guides/setup#run), [French](/fr) and [Other](/guides/setup/)."
    );
  });

  it("takes the deployment base off an image in the assistant's snapshot", async () => {
    // The chat panel mounts every link and image under the base, so one
    // written with it would carry it twice.
    const project = await scanFixture({
      ...FILES,
      "docs/guides/leaf.md":
        "# Leaf\n\n![logo](/sub/logo.png) ![mark](/mark.png) ![far](/sub//cdn.example/x.png)\n",
    });
    const { documents } = await buildAskData(project);
    expect(
      documents.find((doc) => doc.route === "/guides/leaf")?.content
    ).toContain(
      "![logo](/logo.png) ![mark](/mark.png) ![far](/sub//cdn.example/x.png)"
    );
  });

  it("reads a raw `<a href>` the way the browser does", async () => {
    // The rendered page ships it as written, so it resolves against the
    // page's slashless URL: an index page's parent folder, and a `.md`
    // target is a Markdown copy rather than a file link.
    const project = await scanFixture({
      ...FILES,
      "docs/guides/index.md":
        '# Guides\n\n<a href="./install">Install</a>, not <a href="./diagram.png">the diagram</a>, <a href="#top">the top</a> or <a href="https://example.com/x">elsewhere</a>.\n',
      "docs/guides/leaf.md": '# Leaf\n\n<a href="./setup.md#run">Copy</a>\n',
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/guides"]?.mdx).toContain(
      '<a href="/sub/install">Install</a>, not <a href="./diagram.png">the diagram</a>, <a href="#top">the top</a> or <a href="https://example.com/x">elsewhere</a>.'
    );
    expect(raw["/guides/leaf"]?.mdx).toContain(
      '<a href="/sub/guides/setup.md#run">Copy</a>'
    );
    const { documents } = await buildAskData(project);
    const content = (route: string) =>
      documents.find((doc) => doc.route === route)?.content;
    expect(content("/guides")).toContain('<a href="/install">Install</a>');
    expect(content("/guides/leaf")).toContain(
      '<a href="/guides/setup.md#run">Copy</a>'
    );
  });

  it("never moves a raw relative `<a href>` into the page's locale", async () => {
    // The browser resolves it from the French page's URL, and nothing
    // localizes a relative href, so it leaves the locale where it climbs out.
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };',
      "docs/fr/guides/leaf.md":
        '# Feuille\n\n<a href="../../guides/setup">English</a> <a href="./setup">Français</a> [Lien](../../guides/setup.md)\n',
      "docs/fr/guides/setup.md": "# Configurer\n",
      "docs/guides/leaf.md": "# Leaf\n",
      "docs/guides/setup.md": "# Setup\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/fr/guides/leaf"]?.mdx).toContain(
      '<a href="/guides/setup">English</a> <a href="/fr/guides/setup">Français</a> [Lien](/fr/guides/setup)'
    );
  });

  it("resolves each page's links from its own file when two share a route", async () => {
    // `BLUME_DUPLICATE_ROUTE` is reported, but a dev regeneration still
    // builds the snapshot, one document per page.
    const project = await scanFixture({
      "docs/guides/install.md": "# Install\n",
      "docs/guides/setup.md": "# Setup\n\n[Leaf](./install)\n",
      "docs/guides/setup/index.md": "# Setup\n\n[Index](./install)\n",
    });
    const { documents } = await buildAskData(project);
    const contents = documents.map((doc) => doc.content);
    expect(contents).toContain("# Setup\n\n[Leaf](/guides/install)");
    expect(contents).toContain("# Setup\n\n[Index](/guides/setup/install)");
  });

  it("resolves a staged page's links by its path under the staging dir", async () => {
    // A remote source's pages have no file on disk; they link each other as
    // they do in their repo, and the rendered page resolves that already.
    const entries = [
      entry(
        "wiki/index.md",
        "Wiki",
        "See [Setup](./tools/setup.md#run) and [Install](./tools/install)."
      ),
      // A slug moves the page, so only the entry id finds it.
      {
        ...entry(
          "wiki/tools/setup.md",
          "Setup",
          "Back to [the wiki](../index.md), on to [Install](./install.md)."
        ),
        data: { slug: "wiki/configure", title: "Setup" },
      },
      entry("wiki/tools/install.md", "Install", "# Install"),
    ];
    const project = await scanFixture({
      "blume.config.ts": `export default {
  content: {
    sources: [
      { kind: "filesystem", options: { root: "docs" }, requiredSecrets: [], runtimeDeps: [] },
      {
        kind: "custom",
        options: {
          load: () => Promise.resolve({ diagnostics: [], entries: ${JSON.stringify(entries)} }),
          name: "remote",
          staged: true,
        },
        requiredSecrets: [],
        runtimeDeps: [],
      },
    ],
  },
};
`,
      "docs/index.md": "# Home\n",
    });
    const raw = await buildRawMarkdown(project);
    // A file link resolves by entry id (the route-relative reading would give
    // `/wiki/tools/setup` and `/`); a route link against the page's folder,
    // which for an index page is its own.
    expect(raw["/wiki"]?.mdx).toContain(
      "See [Setup](/wiki/configure#run) and [Install](/wiki/tools/install)."
    );
    expect(raw["/wiki/configure"]?.mdx).toContain(
      "Back to [the wiki](/wiki), on to [Install](/wiki/tools/install)."
    );
    const { full } = await buildLlmsFiles(project);
    expect(full).toContain(
      "See [Setup](/wiki/configure#run) and [Install](/wiki/tools/install)."
    );
    const { documents } = await buildAskData(project);
    expect(
      documents.find((doc) => doc.route === "/wiki/configure")?.content
    ).toContain(
      "Back to [the wiki](/wiki), on to [Install](/wiki/tools/install)."
    );
  });

  it("percent-encodes a quote in a route spliced into an attribute", async () => {
    // `don't.md` publishes at `/guides/don't`, which would end a
    // single-quoted `href`, as a `slug` with `"` would end a double-quoted
    // one (Windows allows no `"` in a file name).
    const project = await scanFixture({
      ...FILES,
      "docs/guides/cards.mdx": [
        "# Cards",
        "",
        "<Card href='./don%27t.md' title=\"Don't\" />",
        '<Card href="./hi.md" title="Hi" />',
        "",
      ].join("\n"),
      "docs/guides/don't.md": "# Don't\n",
      "docs/guides/hi.md": "---\nslug: 'guides/say\"hi'\n---\n# Hi\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/guides/cards"]?.mdx).toContain(
      "<Card href='/sub/guides/don%27t' title=\"Don't\" />"
    );
    expect(raw["/guides/cards"]?.mdx).toContain(
      '<Card href="/sub/guides/say%22hi" title="Hi" />'
    );
  });

  it("percent-encodes angle brackets in a staged page's route", async () => {
    // A remote source's file can carry a name no filesystem allows.
    const entries = [
      entry("wiki/index.md", "Wiki", "See [the tag](./a%3Cb%3E.md)."),
      entry("wiki/a<b>.md", "Tag", "# Tag"),
    ];
    const project = await scanFixture({
      "blume.config.ts": `export default {
  content: {
    sources: [
      { kind: "filesystem", options: { root: "docs" }, requiredSecrets: [], runtimeDeps: [] },
      {
        kind: "custom",
        options: {
          load: () => Promise.resolve({ diagnostics: [], entries: ${JSON.stringify(entries)} }),
          name: "remote",
          staged: true,
        },
        requiredSecrets: [],
        runtimeDeps: [],
      },
    ],
  },
};
`,
      "docs/index.md": "# Home\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/wiki"]?.mdx).toContain("See [the tag](/wiki/a%3Cb%3E).");
  });

  it("leaves a page with neither a source file nor an entry id as written", async () => {
    const project = await scanFixture(FILES);
    const rewrite = relativeLinkRewriter(project);
    expect(rewrite("[Install](./install)", { route: "/remote" })).toBe(
      "[Install](./install)"
    );
  });
});
