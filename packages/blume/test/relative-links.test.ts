import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { join, normalize } from "pathe";

import {
  publishRuntimeModules,
  readRuntimeModule,
  RUNTIME_MODULE_FILES,
} from "../src/astro/runtime-modules.ts";
import type { RuntimeModuleId } from "../src/astro/runtime-modules.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";

/** Relative page links are rewritten to the route they mean at render time. */

// An absolute path on this platform (with a drive letter on Windows), as the
// processors receive from the CLI; `pathToFileURL` adds the drive to a bare
// POSIX path there, which would no longer sit under a drive-less root.
const SITE = normalize(path.resolve("/site"));
const ROOT = `${SITE}/docs`;

interface Route {
  collection?: string;
  entryId: string;
  fallback?: boolean;
  locale?: string;
  path: string;
}

const snapshot = (
  routes: Route[],
  i18n: { defaultLocale: string; locales: { code: string }[] } | null = null
): string =>
  JSON.stringify({
    config: { i18n },
    routes: routes.map((route) => ({
      collection: "docs",
      fallback: false,
      locale: "",
      ...route,
    })),
  });

const ROUTES: Route[] = [
  { entryId: "guides/index.md", path: "/guides" },
  { entryId: "guides/index.mdx", path: "/guides" },
  { entryId: "guides/install.md", path: "/guides/install" },
  { entryId: "guides/01-setup.mdx", path: "/getting-started" },
  { entryId: "guides/page.md", path: "/guides/page" },
  { entryId: "about.md", path: "/about" },
];

// Publishing replaces the whole snapshot set; keep whatever another suite left
// so this file can't leak into (or out of) the rest of the process.
const saved = new Map<RuntimeModuleId, string>();
for (const id of RUNTIME_MODULE_FILES.keys()) {
  const text = readRuntimeModule(id);
  if (text !== undefined) {
    saved.set(id, text);
  }
}

const publishData = (text: string | null): void => {
  const modules = new Map(saved);
  if (text === null) {
    modules.delete("blume:data");
  } else {
    modules.set("blume:data", text);
  }
  publishRuntimeModules(modules);
};

afterEach(() => publishRuntimeModules(saved));

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const render = async (
  source: string,
  file: string,
  options?: Parameters<typeof blumeMarkdownProcessor>[0],
  processor = blumeMarkdownProcessor
): Promise<string> => {
  const renderer = await processor(
    options ?? { contentRoot: ROOT }
  ).createRenderer({});
  const result = await renderer.render(source, {
    fileURL: pathToFileURL(file),
  });
  return result.code;
};

describe("relative page links", () => {
  it("resolves an index page's links against its own route", async () => {
    publishData(snapshot(ROUTES));
    const html = await render(
      [
        "[Install](./install)",
        "[Setup](./01-setup.mdx#run)",
        "[About](../about.md)",
        "[Missing](./missing.md?x=1)",
      ].join("\n\n"),
      `${ROOT}/guides/index.md`
    );
    expect(html).toContain('href="/guides/install"');
    // A file link lands where the file publishes: its slug, not its name.
    expect(html).toContain('href="/getting-started#run"');
    expect(html).toContain('href="/about"');
    // A file the snapshot doesn't know resolves route-relative, extension off.
    expect(html).toContain('href="/guides/missing?x=1"');
  });

  it("resolves a leaf page's links against its parent directory", async () => {
    publishData(snapshot(ROUTES));
    const html = await render(
      "[Install](./install)\n\n[Up](../about)",
      `${ROOT}/guides/page.md`
    );
    expect(html).toContain('href="/guides/install"');
    expect(html).toContain('href="/about"');
  });

  it("leaves root-relative, external, anchor, and asset links alone", async () => {
    publishData(snapshot(ROUTES));
    const html = await render(
      [
        "[Root](/guides/install)",
        "[Out](https://example.com)",
        "[Here](#top)",
        "[File](./spec.pdf)",
      ].join("\n\n"),
      `${ROOT}/guides/index.md`
    );
    expect(html).toContain('href="/guides/install"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="#top"');
    expect(html).toContain('href="./spec.pdf"');
  });

  it("rewrites reference-style definitions, and in .mdx too", async () => {
    publishData(snapshot(ROUTES));
    const html = await render(
      "[Install][i]\n\n[i]: ./install",
      `${ROOT}/guides/index.md`
    );
    expect(html).toContain('href="/guides/install"');

    const mdx = await render(
      "[Install](./install)",
      `${ROOT}/guides/index.md`,
      { contentRoot: ROOT },
      blumeMdxProcessor
    );
    expect(mdx).toContain('href="/guides/install"');
  });

  it("layers deployment.base over a route that already carries basePath", async () => {
    publishData(
      snapshot([
        { entryId: "guides/index.md", path: "/docs/guides" },
        { entryId: "guides/install.md", path: "/docs/guides/install" },
      ])
    );
    const html = await render(
      "[Install](./install)",
      `${ROOT}/guides/index.md`,
      {
        basePath: "/docs",
        contentRoot: ROOT,
        deployBase: "/base",
      }
    );
    expect(html).toContain('href="/base/docs/guides/install"');
  });

  it("keeps links as written when it can't place the page", async () => {
    publishData(snapshot(ROUTES));
    // Not in the snapshot: an unpublished draft, say.
    expect(
      await render("[Install](./install)", `${ROOT}/guides/draft.md`)
    ).toContain('href="./install"');
    // Outside the content root, and no staged entry names it.
    expect(
      await render("[Install](./install)", "/elsewhere/guides/index.md")
    ).toContain('href="./install"');
    // No file URL to place it by.
    const renderer = await blumeMarkdownProcessor({
      contentRoot: ROOT,
    }).createRenderer({});
    const unplaced = await renderer.render("[Install](./install)");
    expect(unplaced.code).toContain('href="./install"');
    // No snapshot published, and no ejected file to read.
    publishData(null);
    expect(
      await render("[Install](./install)", `${ROOT}/guides/index.md`)
    ).toContain('href="./install"');
  });

  it("uses the default locale's route for a shared file, never a fallback copy", async () => {
    publishData(
      snapshot(
        [
          { entryId: "guides/index.$.md", locale: "fr", path: "/fr/guides" },
          { entryId: "guides/index.$.md", locale: "en", path: "/guides" },
          {
            entryId: "guides/install.md",
            fallback: true,
            locale: "fr",
            path: "/fr/guides/install",
          },
          {
            entryId: "guides/install.md",
            locale: "en",
            path: "/guides/install",
          },
        ],
        { defaultLocale: "en", locales: [{ code: "en" }, { code: "fr" }] }
      )
    );
    // `index.$.md` is an index under i18n; the reader's locale is applied
    // later, by LocaleLinks, exactly as for any root-relative link.
    const html = await render(
      "[Install](./install)\n\n[File](./install.md)",
      `${ROOT}/guides/index.$.md`
    );
    expect(html).toContain('href="/guides/install">Install');
    expect(html).toContain('href="/guides/install">File');
  });

  it("places a staged (remote) entry by its path under the staging dir", async () => {
    publishData(
      snapshot([
        { collection: "staged", entryId: "sdk/index.md", path: "/sdk" },
        { collection: "staged", entryId: "sdk/usage.md", path: "/sdk/usage" },
        { collection: "staged", entryId: "index.md", path: "/" },
      ])
    );
    const html = await render(
      "[Usage](./usage.md)\n\n[Next](./usage)",
      `${SITE}/.blume/content/sdk/index.md`
    );
    expect(html).toContain('href="/sdk/usage">Usage');
    expect(html).toContain('href="/sdk/usage">Next');
    // A docs-tree file the snapshot doesn't know is never read as staged.
    expect(await render("[Usage](./usage)", `${ROOT}/sdk/index.md`)).toContain(
      'href="./usage"'
    );
  });

  it("reads an ejected app's snapshot file when nothing was published", async () => {
    publishData(null);
    const dir = await mkdtemp(join(tmpdir(), "blume-relative-links-"));
    dirs.push(dir);
    const dataFile = join(dir, "data.json");
    await writeFile(dataFile, snapshot(ROUTES));
    const options = { contentRoot: ROOT, dataFile };
    const renderer = await blumeMarkdownProcessor(options).createRenderer({});
    const renderIndex = async (source: string) => {
      const result = await renderer.render(source, {
        fileURL: pathToFileURL(`${ROOT}/guides/index.md`),
      });
      return result.code;
    };

    expect(await renderIndex("[Install](./install)")).toContain(
      'href="/guides/install"'
    );
    // Unchanged file: the cached index is reused.
    expect(await renderIndex("[About](../about)")).toContain('href="/about"');
    // A rewritten file is read again.
    await writeFile(
      dataFile,
      snapshot([
        { entryId: "guides/index.md", path: "/v2/guides" },
        { entryId: "guides/install.md", path: "/v2/guides/install" },
      ])
    );
    const later = new Date(Date.now() + 5000);
    await utimes(dataFile, later, later);
    expect(await renderIndex("[Install](./install)")).toContain(
      'href="/v2/guides/install"'
    );
    // A missing file places nothing.
    await rm(dataFile);
    expect(await renderIndex("[Install](./install)")).toContain(
      'href="./install"'
    );
  });

  it("rewrites a dotted page name, but leaves an asset alone", async () => {
    publishData(
      snapshot([
        ...ROUTES,
        { entryId: "guides/node.js.mdx", path: "/guides/node.js" },
        { entryId: "v1.2.mdx", path: "/v1.2" },
      ])
    );
    const html = await render(
      "[Node](./node.js#run) [v1.2](../v1.2) [Diagram](./diagram.png)",
      `${ROOT}/guides/index.md`
    );
    expect(html).toContain('href="/guides/node.js#run"');
    expect(html).toContain('href="/v1.2"');
    expect(html).toContain('href="./diagram.png"');
  });

  it("rewrites a component's string href, leaving expressions and HTML", async () => {
    publishData(snapshot(ROUTES));
    // The MDX compile path `@astrojs/mdx` runs: JSX elements are only
    // visited there, not in the `.md`-style HTML renderer above.
    const processor = blumeMdxProcessor({ contentRoot: ROOT });
    if (!processor.createMdxRenderer) {
      throw new Error("The satteri processor has no MDX renderer.");
    }
    const renderer = await processor.createMdxRenderer({}, { optimize: false });
    const { code } = await renderer.process(
      [
        '<Card title="Install" href="./install">',
        '  Nested [link](./page) and <Tile href="./page" />',
        "</Card>",
        "",
        "<Card href={props.target} />",
        "",
        'Inline <Tile href="../about">About</Tile> tile.',
        "",
        '<a href="./install">raw</a>',
      ].join("\n"),
      `${ROOT}/guides/index.mdx`,
      {}
    );
    const compiled = String(code);
    expect(compiled).toContain('href: "/guides/install"');
    expect(compiled).toContain('href: "/guides/page"');
    expect(compiled).toContain('href: "/about"');
    expect(compiled).toContain("href: props.target");
    expect(compiled).toContain('href: "./install"');
  });

  it("falls back to the default tree for a sibling a locale hasn't translated", async () => {
    publishData(
      snapshot(
        [
          {
            entryId: "guides/setup.mdx",
            locale: "en",
            path: "/getting-started",
          },
          {
            entryId: "guides/install.md",
            locale: "en",
            path: "/guides/install",
          },
          { entryId: "fr/guides/index.md", locale: "fr", path: "/fr/guides" },
          {
            entryId: "fr/guides/install.md",
            locale: "fr",
            path: "/fr/guides/install",
          },
        ],
        { defaultLocale: "en", locales: [{ code: "en" }, { code: "fr" }] }
      )
    );
    const html = await render(
      "[Setup](./setup.mdx) [Install](./install.md) [Gone](./gone.mdx)",
      `${ROOT}/fr/guides/index.md`
    );
    // The default tree's file, its slug included; the page moves it into the
    // reader's locale afterwards (LocaleLinks), onto the fallback copy.
    expect(html).toContain('href="/getting-started"');
    // A translated sibling keeps its own route.
    expect(html).toContain('href="/fr/guides/install"');
    // Neither tree has it: route-relative, as before.
    expect(html).toContain('href="/fr/guides/gone"');
  });

  it("reads an archived page's untranslated sibling from its version's tree", async () => {
    // An archived version keeps its locale folders inside its own folder.
    publishData(
      JSON.stringify({
        config: {
          i18n: {
            defaultLocale: "en",
            locales: [{ code: "en" }, { code: "fr" }],
          },
          versions: { archived: [{ id: "v1.0" }] },
        },
        routes: [
          { entryId: "guides/setup.mdx", locale: "en", path: "/configure" },
          {
            entryId: "v1.0/guides/setup.mdx",
            locale: "en",
            path: "/v1.0/configure",
          },
          {
            entryId: "v1.0/fr/guides/leaf.md",
            locale: "fr",
            path: "/fr/v1.0/guides/leaf",
          },
          { entryId: "v1.0/leaf.md", locale: "en", path: "/v1.0/leaf" },
          {
            entryId: "v1.0/guides/other.md",
            locale: "en",
            path: "/v1.0/guides/other",
          },
        ].map((route) => ({ collection: "docs", fallback: false, ...route })),
      })
    );
    const html = await render(
      "[Setup](./setup.mdx)",
      `${ROOT}/v1.0/fr/guides/leaf.md`
    );
    expect(html).toContain('href="/v1.0/configure"');
    // An archived page outside a locale folder has no other tree: a missing
    // sibling stays route-relative, not the version's top-level file.
    expect(
      await render("[Leaf](./leaf.md)", `${ROOT}/v1.0/guides/other.md`)
    ).toContain('href="/v1.0/guides/leaf"');
  });
});

describe("root-relative links to content files", () => {
  it("lands on the page the named file publishes, from any page", async () => {
    publishData(snapshot(ROUTES));
    const html = await render(
      [
        "[Setup](/guides/01-setup.mdx#run) [About](/about.md?x=1)",
        "[Copy](/guides/missing.md) [Other](/about.mdx) [Route](/about)",
        "",
        "[ref]: /guides/install.md",
        "",
        "[By ref][ref]",
      ].join("\n"),
      `${ROOT}/guides/page.md`
    );
    expect(html).toContain('href="/getting-started#run"');
    expect(html).toContain('href="/about?x=1"');
    expect(html).toContain('href="/guides/install"');
    // No source file by that name: a page's Markdown copy, kept as written.
    expect(html).toContain('href="/guides/missing.md"');
    expect(html).toContain('href="/about.mdx"');
    expect(html).toContain('href="/about"');
  });

  it("reads a link that starts with deployment.base as including it", async () => {
    publishData(snapshot(ROUTES));
    const html = await render(
      "[About](/about.md) [Based](/base/guides/install.md) [Base](/base.md)",
      `${ROOT}/guides/page.md`,
      { contentRoot: ROOT, deployBase: "/base" }
    );
    expect(html).toContain('href="/base/about"');
    expect(html).toContain('href="/base/guides/install"');
    expect(html).toContain('href="/base/base.md"');
  });

  it("rewrites a component's href too, but not a raw <a>", async () => {
    publishData(snapshot(ROUTES));
    const processor = blumeMdxProcessor({ contentRoot: ROOT });
    if (!processor.createMdxRenderer) {
      throw new Error("The satteri processor has no MDX renderer.");
    }
    const renderer = await processor.createMdxRenderer({}, { optimize: false });
    const { code } = await renderer.process(
      '<Card href="/about.md" />\n\n<a href="/guides/install.md">Copy</a>',
      `${ROOT}/guides/index.mdx`,
      {}
    );
    expect(String(code)).toContain('href: "/about"');
    expect(String(code)).toContain('href: "/guides/install.md"');
  });

  it("leaves them alone with no content root or no snapshot", async () => {
    publishData(snapshot(ROUTES));
    expect(
      await render("[About](/about.md)", `${ROOT}/guides/page.md`, {})
    ).toContain('href="/about.md"');
    publishData(null);
    expect(
      await render("[About](/about.md)", `${ROOT}/guides/page.md`)
    ).toContain('href="/about.md"');
  });
});
