import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import matter from "../src/core/frontmatter.ts";

// The blume-migrate skill's zero-dependency frontmatter codemod, run the way
// the skill runs it: a bare `node` over the repo-root copy (the package's
// `skills/` is a generated mirror of it).
const CODEMOD = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "skills",
  "blume-migrate",
  "scripts",
  "mintlify-codemod.mjs"
);

const root = mkdtempSync(join(tmpdir(), "blume-codemod-"));

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const runCodemod = (...args: string[]): string => {
  const result = spawnSync("node", [CODEMOD, ...args], { encoding: "utf-8" });
  expect(result.status).toBe(0);
  return result.stdout;
};

describe("mintlify-codemod", () => {
  it("drops a key whose list items sit flush at column 0", async () => {
    const file = join(root, "page.mdx");
    await writeFile(
      file,
      [
        "---",
        "title: Hello",
        "rss:",
        "- one",
        "- two",
        "groups:",
        "  - admin",
        "tags:",
        "- kept",
        "---",
        "",
        "# Hello",
        "",
      ].join("\n")
    );

    const report = runCodemod("--write", file);
    expect(report).toContain("dropped: rss");
    expect(report).toContain("dropped: groups");

    const text = await readFile(file, "utf-8");
    expect(text).toBe(
      ["---", "title: Hello", "tags:", "- kept", "---", "", "# Hello", ""].join(
        "\n"
      )
    );
    expect(matter(text).data).toEqual({ tags: ["kept"], title: "Hello" });
    // Idempotent: nothing left to drop on a second pass.
    expect(runCodemod(file)).toContain("0 file(s) with findings");
  });

  it("moves search keys into the search block, flipping searchable", async () => {
    const file = join(root, "search.mdx");
    await writeFile(
      file,
      [
        "---",
        "title: Search",
        "boost: 5",
        'keywords: ["install", "setup"]',
        "searchable: false",
        "---",
        "",
      ].join("\n")
    );
    const report = runCodemod("--write", file);
    expect(report).toContain("boost → search.boost");
    expect(matter(await readFile(file, "utf-8")).data).toEqual({
      search: { boost: 5, exclude: true, keywords: ["install", "setup"] },
      title: "Search",
    });

    const shown = join(root, "searchable.mdx");
    await writeFile(
      shown,
      ["---", "title: Shown", "searchable: true", "---", ""].join("\n")
    );
    expect(runCodemod("--write", shown)).toContain("dropped: searchable: true");
    expect(matter(await readFile(shown, "utf-8")).data).toEqual({
      title: "Shown",
    });
  });

  it("maps hideFooterPagination and mode by value, and keeps api pages", async () => {
    const file = join(root, "values.mdx");
    await writeFile(
      file,
      [
        "---",
        "title: Endpoint",
        "api: POST /v1/users",
        "mode: wide",
        "hideFooterPagination: true",
        "---",
        "",
      ].join("\n")
    );
    const report = runCodemod("--write", file);
    expect(report).toContain("hideFooterPagination: true → pagination: false");
    expect(report).not.toContain("FLAG");
    expect(matter(await readFile(file, "utf-8")).data).toEqual({
      api: "POST /v1/users",
      mode: "wide",
      pagination: false,
      title: "Endpoint",
    });
    expect(runCodemod(file)).toContain("0 file(s) with findings");

    const other = join(root, "assistant.mdx");
    await writeFile(
      other,
      [
        "---",
        "title: Chat",
        'mode: "assistant"',
        "hideFooterPagination: false",
        "---",
        "",
      ].join("\n")
    );
    const dropped = runCodemod("--write", other);
    expect(dropped).toContain("dropped: mode: assistant");
    expect(dropped).toContain("dropped: hideFooterPagination: false");
    expect(matter(await readFile(other, "utf-8")).data).toEqual({
      title: "Chat",
    });
  });

  it("leaves an existing pagination key and a structured value for review", async () => {
    const file = join(root, "conflict.mdx");
    const source = [
      "---",
      "pagination: true",
      "hideFooterPagination: true",
      "mode:",
      "  nested: x",
      "---",
      "",
    ].join("\n");
    await writeFile(file, source);
    const report = runCodemod("--write", file);
    expect(report).toContain(
      "hideFooterPagination → pagination (child-exists)"
    );
    expect(report).toContain("rename needs manual edit: mode");
    expect(await readFile(file, "utf-8")).toBe(source);
  });
});
