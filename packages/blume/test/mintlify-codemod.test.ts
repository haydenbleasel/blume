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
        "keywords:",
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
    expect(report).toContain("dropped: keywords");
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
});
