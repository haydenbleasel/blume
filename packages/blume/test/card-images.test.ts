import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  publishRuntimeModules,
  readRuntimeModule,
  RUNTIME_MODULE_FILES,
} from "../src/astro/runtime-modules.ts";
import type { RuntimeModuleId } from "../src/astro/runtime-modules.ts";
import {
  collectContentAssets,
  rewriteRelativeAssets,
} from "../src/core/content-assets.ts";
import { expandIncludes } from "../src/core/includes.ts";
import { validateLinks } from "../src/core/links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import {
  extractLinks,
  rewriteCardImages,
} from "../src/core/sources/normalize.ts";
import { blumeMdxProcessor } from "../src/markdown/index.ts";

/**
 * A `<Card img>` is an image embed: resolved from beside the page, rebased out
 * of a partial, served by the content-assets endpoint, and validated, like
 * `![](./cover.png)`.
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

const publishAssets = (assets: Record<string, string> | null): void => {
  const modules = new Map(saved);
  if (assets === null) {
    modules.delete("blume:content-assets");
  } else {
    modules.set("blume:content-assets", JSON.stringify(assets));
  }
  publishRuntimeModules(modules);
};

/** A project on disk with the given files. */
const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-card-images-"));
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

/** Compile an `.mdx` page the way `@astrojs/mdx` does, returning its code. */
const compile = async (
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

describe(rewriteCardImages, () => {
  it("rewrites each card's img outside code, keeping what `rewrite` declines", () => {
    const text = [
      '<Card title="A" img="./a.png" />',
      "<Card",
      '  img="./b.png"',
      "/>",
      '`<Card img="./code.png" />` <Card img={cover} /> <Tile img="./tile.png" />',
      '<Card img="https://x.dev/c.png" />',
    ].join("\n");
    expect(
      rewriteCardImages(
        text,
        (target) =>
          target.startsWith("./") ? `/served/${target.slice(2)}` : null,
        null
      )
    ).toBe(
      [
        '<Card title="A" img="/served/a.png" />',
        "<Card",
        '  img="/served/b.png"',
        "/>",
        '`<Card img="./code.png" />` <Card img={cover} /> <Tile img="./tile.png" />',
        '<Card img="https://x.dev/c.png" />',
      ].join("\n")
    );
    expect(rewriteCardImages("No cards.", () => "x", null)).toBe("No cards.");
  });

  it("is read as an image embed by link extraction", () => {
    expect(
      extractLinks(
        '<Card title="A" img="./a.png" />\n<Card img="" />',
        0,
        "mdx"
      )
    ).toStrictEqual([{ column: 22, image: true, line: 1, target: "./a.png" }]);
  });
});

describe("<Card img> through the content pipeline", () => {
  it("rebases a partial's card image, serves it, and validates it", async () => {
    const root = await project({
      "docs/_parts/card.mdx": '<Card title="Up" img="./cover.png" />\n',
      "docs/_parts/cover.png": "png",
      "docs/guides/here.png": "png",
      "docs/guides/index.mdx": [
        "---",
        "title: Guides",
        "---",
        "",
        "<include>../_parts/card.mdx</include>",
        "",
        '<Card title="Here" img="./here.png" />',
        "",
        '<Card title="Gone" img="./gone.png" />',
        "",
      ].join("\n"),
    });
    const page = join(root, "docs/guides/index.mdx");
    const expanded = await expandIncludes(
      "<include>../_parts/card.mdx</include>",
      { sourcePath: page }
    );
    expect(expanded.text).toBe('<Card title="Up" img="../_parts/cover.png" />');

    const scanned = await scanProject(root, { mode: "build" });
    const assets = await collectContentAssets(scanned);
    expect(assets).toStrictEqual({
      "docs/_parts/cover.png": join(root, "docs/_parts/cover.png"),
      "docs/guides/here.png": join(root, "docs/guides/here.png"),
    });
    expect(
      rewriteRelativeAssets({
        deployBase: "/base",
        format: "mdx",
        projectRoot: root,
        source: '<Card img="./here.png" />',
        sourcePath: page,
      })
    ).toBe('<Card img="/base/blume-assets/content/docs/guides/here.png" />');

    const diagnostics = await validateLinks(scanned.graph, {
      publicDir: null,
    });
    expect(diagnostics.map((d) => [d.code, d.message])).toStrictEqual([
      [
        "BLUME_BROKEN_ASSET",
        "Image ./gone.png was not found next to index.mdx.",
      ],
    ]);
  });

  it("points a served card image at its endpoint URL in the render", async () => {
    const root = await project({ "docs/cover.png": "png" });
    const page = join(root, "docs/index.mdx");
    publishAssets({ "docs/cover.png": join(root, "docs/cover.png") });
    const code = await compile(
      [
        '<Card title="A" img="./cover.png" href="/a" />',
        '<Card title="B" img="./missing.png" />',
        "<Card img={cover} />",
        '<Tile img="./cover.png" />',
      ].join("\n\n"),
      page,
      { deployBase: "/base" }
    );
    expect(code).toContain('img: "/base/blume-assets/content/docs/cover.png"');
    expect(code).toContain('img: "./missing.png"');
    expect(code).toContain("img: cover");
    // Only a card's `img` is an image embed.
    expect(code).toContain('img: "./cover.png"');
  });

  it("reads an ejected app's content-assets file beside its data file", async () => {
    publishAssets(null);
    const root = await project({ "docs/cover.png": "png" });
    const generated = join(root, "src/generated");
    await mkdir(generated, { recursive: true });
    await writeFile(
      join(generated, "content-assets.json"),
      JSON.stringify({ "docs/cover.png": join(root, "docs/cover.png") })
    );
    const page = join(root, "docs/index.mdx");
    const source = '<Card img="./cover.png" />';
    expect(
      await compile(source, page, { dataFile: join(generated, "data.json") })
    ).toContain('img: "/blume-assets/content/docs/cover.png"');
    // With neither, the card keeps its value.
    expect(await compile(source, page)).toContain('img: "./cover.png"');
  });
});
