import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  collectContentAssets,
  CONTENT_ASSETS_PREFIX,
  contentAssetParam,
  rewriteRelativeImages,
} from "../src/core/content-assets.ts";

let root: string;
let pagePath: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-content-assets-"));
  await mkdir(join(root, "docs", "images"), { recursive: true });
  await mkdir(join(root, "docs", "dir.png"), { recursive: true });
  pagePath = join(root, "docs", "page.mdx");
  await Promise.all([
    writeFile(join(root, "docs", "photo.png"), "png"),
    writeFile(join(root, "docs", "images", "nested.png"), "png"),
    writeFile(join(root, "docs", "my photo.png"), "png"),
    writeFile(join(root, "shared.png"), "png"),
    writeFile(join(root, "docs", "spec.pdf"), "pdf"),
    writeFile(pagePath, "unused"),
  ]);
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const rewrite = (
  source: string,
  over: Partial<Parameters<typeof rewriteRelativeImages>[0]> = {}
): string =>
  rewriteRelativeImages({
    projectRoot: root,
    source,
    sourcePath: pagePath,
    ...over,
  });

describe("rewriteRelativeImages", () => {
  it("rewrites a colocated relative image to its served URL", () => {
    expect(rewrite("![Alt](./photo.png)")).toBe(
      `![Alt](${CONTENT_ASSETS_PREFIX}/docs/photo.png)`
    );
  });

  it("resolves ../ segments and nested folders", () => {
    const out = rewrite("![a](../shared.png) and ![b](./images/nested.png)");
    expect(out).toBe(
      `![a](${CONTENT_ASSETS_PREFIX}/shared.png) and ![b](${CONTENT_ASSETS_PREFIX}/docs/images/nested.png)`
    );
  });

  it("rewrites a bare relative path the way Astro treats one", () => {
    expect(rewrite("![Alt](photo.png)")).toBe(
      `![Alt](${CONTENT_ASSETS_PREFIX}/docs/photo.png)`
    );
  });

  it("keeps a title suffix intact", () => {
    expect(rewrite('![Alt](./photo.png "The title")')).toBe(
      `![Alt](${CONTENT_ASSETS_PREFIX}/docs/photo.png "The title")`
    );
  });

  it("rewrites an image nested inside a link label", () => {
    expect(rewrite("[![Alt](./photo.png)](https://example.com)")).toBe(
      `[![Alt](${CONTENT_ASSETS_PREFIX}/docs/photo.png)](https://example.com)`
    );
  });

  it("leaves remote, public-absolute, and fragment targets alone", () => {
    const source =
      "![r](https://example.com/x.png) ![p](/public.png) ![f](#frag)";
    expect(rewrite(source)).toBe(source);
  });

  it("leaves references to missing files and non-images alone", () => {
    // `./nope/missing.png` has no parent directory at all — the resolver must
    // treat an unreadable parent the same as a missing file.
    const source =
      "![m](./missing.png) ![d](./spec.pdf) ![n](./nope/missing.png)";
    expect(rewrite(source)).toBe(source);
  });

  it("leaves case-mismatched and directory references alone", () => {
    // `./Photo.PNG` passes a bare existsSync on a case-insensitive filesystem
    // but breaks on the Linux build; `./dir.png` is a directory. Neither is a
    // servable colocated image, so neither may be rewritten.
    const source = "![c](./Photo.PNG) ![d](./dir.png)";
    expect(rewrite(source)).toBe(source);
  });

  it("leaves a malformed percent-escape target alone", () => {
    const source = "![m](./ph%zzoto.png)";
    expect(rewrite(source)).toBe(source);
  });

  it("skips fenced code blocks and inline code", () => {
    const source = [
      "![real](./photo.png)",
      "```md",
      "![example](./photo.png)",
      "```",
      "and `![inline](./photo.png)` stays",
    ].join("\n");
    const out = rewrite(source);
    expect(out).toContain(`![real](${CONTENT_ASSETS_PREFIX}/docs/photo.png)`);
    expect(out).toContain("![example](./photo.png)");
    expect(out).toContain("`![inline](./photo.png)` stays");
  });

  it("decodes an encoded source reference before resolving it", () => {
    expect(rewrite("![Alt](./my%20photo.png)")).toBe(
      `![Alt](${CONTENT_ASSETS_PREFIX}/docs/my%20photo.png)`
    );
  });

  it("prefixes the deployment base when configured", () => {
    expect(rewrite("![Alt](./photo.png)", { deployBase: "/base/" })).toBe(
      `![Alt](/base${CONTENT_ASSETS_PREFIX}/docs/photo.png)`
    );
  });

  it("reports each rewritten asset to the register callback", () => {
    const seen: Record<string, string> = {};
    rewrite("![a](./photo.png) ![b](./photo.png) ![c](../shared.png)", {
      register: (param: string, abs: string) => {
        seen[param] = abs;
      },
    });
    expect(seen).toEqual({
      "docs/photo.png": join(root, "docs", "photo.png"),
      "shared.png": join(root, "shared.png"),
    });
  });
});

describe("contentAssetParam", () => {
  it("uses the project-relative path inside the root", () => {
    expect(contentAssetParam(root, join(root, "docs", "photo.png"))).toBe(
      "docs/photo.png"
    );
  });

  it("falls back to a content-addressed name outside the root", () => {
    const param = contentAssetParam(root, "/elsewhere/photo.png");
    expect(param).toMatch(/^_\/[a-z0-9]+\.png$/u);
  });
});

describe("collectContentAssets", () => {
  it("maps every referenced asset across routes, skipping unreadable ones", async () => {
    const page2 = join(root, "docs", "images", "gallery.md");
    await writeFile(page2, "![n](./nested.png)");
    await writeFile(pagePath, "![p](./photo.png)\n![m](./missing.png)");
    const files = await collectContentAssets({
      context: { root },
      graph: { pages: [] },
      manifest: {
        routes: [
          { id: "p1", sourcePath: pagePath },
          { id: "p2", sourcePath: page2 },
          { id: "p3", sourcePath: join(root, "docs", "gone.md") },
          { id: "p4" },
        ],
      },
    });
    expect(files).toEqual({
      "docs/images/nested.png": join(root, "docs", "images", "nested.png"),
      "docs/photo.png": join(root, "docs", "photo.png"),
    });
  });
});
