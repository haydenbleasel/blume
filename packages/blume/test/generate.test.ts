import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join, normalize } from "pathe";

import { pruneOrphans } from "../src/astro/generate.ts";

let srcDir: string;

beforeEach(async () => {
  srcDir = await mkdtemp(join(tmpdir(), "blume-prune-"));
});

afterEach(async () => {
  await rm(srcDir, { force: true, recursive: true });
});

// Create a file under srcDir and return its normalized absolute path, matching
// the shape the generator records in its `written` set.
const touch = async (rel: string): Promise<string> => {
  const path = join(srcDir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x", "utf-8");
  return normalize(path);
};

describe("pruneOrphans", () => {
  it("deletes files the pass didn't write and keeps the rest", async () => {
    const keepPage = await touch("pages/[...slug].astro");
    const keepData = await touch("generated/data.json");
    // A server-rendered endpoint left behind after a feature was switched off.
    await touch("pages/api/ask.ts");

    await pruneOrphans(srcDir, new Set([keepPage, keepData]));

    expect(existsSync(join(srcDir, "pages", "[...slug].astro"))).toBe(true);
    expect(existsSync(join(srcDir, "generated", "data.json"))).toBe(true);
    expect(existsSync(join(srcDir, "pages", "api", "ask.ts"))).toBe(false);
  });

  it("leaves every file when all were written", async () => {
    const env = await touch("env.d.ts");
    const page = await touch("pages/index.astro");

    await pruneOrphans(srcDir, new Set([env, page]));

    expect(existsSync(join(srcDir, "env.d.ts"))).toBe(true);
    expect(existsSync(join(srcDir, "pages", "index.astro"))).toBe(true);
  });
});
