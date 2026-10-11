import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { dirname, join } from "pathe";

import {
  publishRuntimeModules,
  readRuntimeModule,
  RUNTIME_MODULE_FILES,
} from "../src/astro/runtime-modules.ts";
import type { RuntimeModuleId } from "../src/astro/runtime-modules.ts";
import { collectContentAssets } from "../src/core/content-assets.ts";
import { validateLinks } from "../src/core/links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";

/**
 * A link to a file beside the page (`[spec](./spec.pdf)`), and an element's
 * `src` or `href` naming one (`<img src="./a.png">`), is published with the
 * page and pointed at its served copy, in `.md` raw HTML and `.mdx` alike.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

// Publishing replaces the whole snapshot set; keep whatever another suite left.
const saved = new Map<RuntimeModuleId, string>();
for (const id of RUNTIME_MODULE_FILES.keys()) {
  const text = readRuntimeModule(id);
  if (text !== undefined) {
    saved.set(id, text);
  }
}
afterEach(() => publishRuntimeModules(saved));

const publishAssets = (assets: Record<string, string>): void => {
  const modules = new Map(saved);
  modules.set("blume:content-assets", JSON.stringify(assets));
  publishRuntimeModules(modules);
};

/** A project on disk with the given files. */
const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-file-links-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    })
  );
  return root;
};

/** Render a `.md` page, returning its HTML. */
const renderMd = async (
  source: string,
  file?: string,
  options: Parameters<typeof blumeMarkdownProcessor>[0] = {}
): Promise<string> => {
  const renderer = await blumeMarkdownProcessor(options).createRenderer({});
  const result = await renderer.render(
    source,
    file ? { fileURL: pathToFileURL(file) } : {}
  );
  return result.code;
};

/** Compile an `.mdx` page the way `@astrojs/mdx` does, returning its code. */
const compileMdx = async (
  source: string,
  file: string,
  options: Parameters<typeof blumeMdxProcessor>[0] = {}
): Promise<string> => {
  const processor = blumeMdxProcessor(options);
  if (!processor.createMdxRenderer) {
    throw new Error("The satteri processor has no MDX renderer.");
  }
  const renderer = await processor.createMdxRenderer({}, { optimize: false });
  const { code } = await renderer.process(source, file, {});
  return String(code);
};

const FILES = {
  "docs/extra.pdf": "pdf",
  "docs/pic.png": "png",
  "docs/spec.pdf": "pdf",
};

describe("files beside the page in the render", () => {
  it("points a .md page's links and raw HTML at the served copies", async () => {
    const root = await project(FILES);
    publishAssets({
      "docs/pic.png": join(root, "docs/pic.png"),
      "docs/spec.pdf": join(root, "docs/spec.pdf"),
    });
    const page = join(root, "docs/index.md");
    const html = await renderMd(
      [
        "[Spec](./spec.pdf#page=2) and [the spec][s].",
        "",
        'Inline <img src="./pic.png" alt="Pic"> and <a href="./spec.pdf">a</a>.',
        "",
        '<div><video src="./spec.pdf"></video><iframe src="./spec.pdf"></iframe></div>',
        "",
        "[Missing](./missing.pdf) [Unserved](./extra.pdf) [Page](./other)",
        "",
        "[s]: ./spec.pdf",
      ].join("\n"),
      page,
      { deployBase: "/base" }
    );
    const served = "/base/blume-assets/content/docs";
    expect(html).toContain(`<a href="${served}/spec.pdf#page=2">Spec</a>`);
    expect(html).toContain(`<a href="${served}/spec.pdf">the spec</a>`);
    expect(html).toContain(`<img src="${served}/pic.png" alt="Pic">`);
    expect(html).toContain(`<a href="${served}/spec.pdf">a</a>`);
    expect(html).toContain(`<video src="${served}/spec.pdf"></video>`);
    // Only what validate reads as a link is published from beside the page.
    expect(html).toContain('<iframe src="./spec.pdf"></iframe>');
    expect(html).toContain('href="./missing.pdf"');
    expect(html).toContain('href="./extra.pdf"');

    // With no file to place the page by, nothing is rewritten.
    expect(await renderMd('[S](./spec.pdf) <img src="./pic.png">')).toContain(
      '<a href="./spec.pdf">S</a> <img src="./pic.png">'
    );
  });

  it("points an .mdx page's links, elements, and component hrefs there", async () => {
    const root = await project(FILES);
    publishAssets({
      "docs/pic.png": join(root, "docs/pic.png"),
      "docs/spec.pdf": join(root, "docs/spec.pdf"),
    });
    const code = await compileMdx(
      [
        "[Spec](./spec.pdf)",
        '<img src="./pic.png" alt="Pic" />',
        '<a href="./spec.pdf">Spec</a>',
        '<Card title="Spec" href="./spec.pdf" img="./pic.png" />',
        '<Card title="Expr" href={spec} {...rest} />',
        '<iframe src="./spec.pdf" />',
        "<>Fragment</>",
      ].join("\n\n"),
      join(root, "docs/index.mdx")
    );
    expect(code).toContain('href: "/blume-assets/content/docs/spec.pdf"');
    expect(code).toContain('src: "/blume-assets/content/docs/pic.png"');
    expect(code).toContain('img: "/blume-assets/content/docs/pic.png"');
    expect(code).not.toContain('href: "./spec.pdf"');
    expect(code).toContain('src: "./spec.pdf"');
    expect(code).toContain("href: spec");
  });
});

describe("files beside the page through the content pipeline", () => {
  it("serves what a page links beside it, and validates the rest", async () => {
    const root = await project({
      "docs/_parts/note.md": '<img src="./shot.png">\n',
      "docs/_parts/shot.png": "png",
      "docs/guides/index.md": [
        "---",
        "title: Guides",
        "---",
        "",
        "<include>../_parts/note.md</include>",
        "",
        "[Spec](./spec.pdf) [Gone](./gone.pdf)",
        "",
        '<video src="./gone.mp4"></video>',
        "",
        "    [Sample](./sample.pdf) is code.",
        "",
      ].join("\n"),
      "docs/guides/sample.pdf": "pdf",
      "docs/guides/spec.pdf": "pdf",
    });
    const scanned = await scanProject(root, { mode: "build" });
    expect(await collectContentAssets(scanned)).toStrictEqual({
      "docs/_parts/shot.png": join(root, "docs/_parts/shot.png"),
      "docs/guides/spec.pdf": join(root, "docs/guides/spec.pdf"),
    });
    const diagnostics = await validateLinks(scanned.graph, {
      publicDir: null,
    });
    expect(diagnostics.map((d) => [d.code, d.message])).toStrictEqual([
      [
        "BLUME_BROKEN_ASSET",
        "Asset /guides/gone.pdf was not found in the public directory.",
      ],
      [
        "BLUME_BROKEN_ASSET",
        `<video src="./gone.mp4"> points at /gone.mp4, which isn't in the public directory, and there's no ./gone.mp4 next to index.md either.`,
      ],
    ]);
  });
});
