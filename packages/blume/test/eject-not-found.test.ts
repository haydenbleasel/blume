import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  notFoundJsonTemplate,
  notFoundMarkdownTemplate,
  notFoundPageTemplate,
} from "../src/astro/templates.ts";
import { eject } from "../src/registry/eject.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** A fresh project dir holding `files` (paths relative to it). */
const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-eject-404-"));
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

const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), "utf-8");

const has = (root: string, rel: string): boolean => existsSync(join(root, rel));

const NOT_FOUND_FILES = [
  "src/pages/404.astro",
  "src/pages/404.md.ts",
  "src/pages/404.json.ts",
];

describe("eject 404 page", () => {
  it("writes the page with its Markdown and JSON twins", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    // The hidden runtime serves `/404.md` and `/404.json` beside the HTML
    // page, so the ejected app answers the same URLs.
    expect(read(root, "src/pages/404.astro")).toBe(notFoundPageTemplate());
    expect(read(root, "src/pages/404.md.ts")).toBe(notFoundMarkdownTemplate());
    expect(read(root, "src/pages/404.json.ts")).toBe(notFoundJsonTemplate());
  });

  it("leaves all three to a custom pages/404.astro", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
      "pages/404.astro": "<h1>Gone</h1>\n",
    });

    await eject(root);

    for (const file of NOT_FOUND_FILES) {
      expect(has(root, file)).toBe(false);
    }
  });

  it("leaves all three to a 404 content page", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "docs/404.md": "---\ntitle: Lost\n---\n# Lost\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    for (const file of NOT_FOUND_FILES) {
      expect(has(root, file)).toBe(false);
    }
  });
});
