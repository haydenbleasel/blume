import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { discoverPages } from "../src/astro/pages.ts";

let root: string;

const FILES = [
  "index.astro",
  "about.astro",
  "blog/index.astro",
  "blog/[slug].astro",
  "nested/deep/index.astro",
];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-pages-"));
  await Promise.all(
    FILES.map(async (rel) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, "<h1>page</h1>");
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("discoverPages", () => {
  it("derives route patterns, collapsing index and preserving dynamic segments", async () => {
    const routes = await discoverPages(root);
    expect(routes.map((route) => route.pattern).toSorted()).toStrictEqual([
      "/",
      "/about",
      "/blog",
      "/blog/[slug]",
      "/nested/deep",
    ]);
  });

  it("keeps the original file as the entrypoint", async () => {
    const routes = await discoverPages(root);
    const about = routes.find((route) => route.pattern === "/about");
    expect(about?.entrypoint).toBe(join(root, "about.astro"));
  });
});
