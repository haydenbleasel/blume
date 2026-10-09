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

  it("reads a sibling a locale hasn't translated from the default tree", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };',
      "docs/fr/guides/index.mdx": "# Guides\n\nSee [Setup](./setup.mdx).\n",
      "docs/guides/index.mdx": "# Guides\n",
      "docs/guides/setup.mdx": "---\nslug: getting-started\n---\n# Setup\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/fr/guides"]?.mdx).toContain("See [Setup](/getting-started).");
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
    // The chat panel mounts the links it renders under `deployment.base`.
    const project = await scanFixture({
      ...FILES,
      "docs/guides/rooted.md": "# Rooted\n\nSee [Install](/guides/install).\n",
    });
    const { documents } = await buildAskData(project);
    const content = (route: string) =>
      documents.find((doc) => doc.route === route)?.content;
    expect(content("/guides/leaf")).toContain(
      "See [Install](/guides/install)."
    );
    expect(content("/guides/rooted")).toContain(
      "See [Install](/guides/install)."
    );
    expect(documents.some((doc) => doc.content.includes("/sub/"))).toBe(false);
  });

  it("rewrites only relative links in the assistant's grounding", async () => {
    // Relative links become the routes the snapshot holds (basePath and all,
    // but no deployment base); root links aren't rewritten here.
    const project = await scanFixture({
      "blume.config.ts": `export default {
  basePath: "/docs",
  deployment: { base: "/sub" },
  i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
};`,
      "docs/fr/guides/leaf.md":
        "# Feuille\n\nVoir [Install](./install.md) et [encore](/guides/install).\n",
      "docs/guides/install.md": "# Install\n",
      "docs/guides/leaf.md":
        "# Leaf\n\nSee [Install](./install) and [it again](/guides/install).\n",
    });
    const { documents } = await buildAskData(project);
    const content = (route: string) =>
      documents.find((doc) => doc.route === route)?.content;
    expect(content("/docs/guides/leaf")).toContain(
      "See [Install](/docs/guides/install) and [it again](/guides/install)."
    );
    // An untranslated sibling is the default tree's page, which the
    // snapshot holds; its French fallback copy isn't in it.
    expect(content("/docs/fr/guides/leaf")).toContain(
      "Voir [Install](/docs/guides/install) et [encore](/guides/install)."
    );
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

  it("leaves a page with neither a source file nor an entry id as written", async () => {
    const project = await scanFixture(FILES);
    const rewrite = relativeLinkRewriter(project);
    expect(rewrite("[Install](./install)", { route: "/remote" })).toBe(
      "[Install](./install)"
    );
  });
});
