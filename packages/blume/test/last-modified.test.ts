import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  parseGitLog,
  resolveLastModifiedConfig,
} from "../src/core/last-modified.ts";
import { scanProject } from "../src/core/project-graph.ts";

// The byte `git log --format=%x00…` prefixes each date line with.
const nul = String.fromCodePoint(0);
const dateLine = (iso: string): string => `${nul}${iso}`;

describe("resolveLastModifiedConfig", () => {
  it("disables on false", () => {
    expect(resolveLastModifiedConfig(false)).toEqual({
      enabled: false,
      source: "git",
    });
  });

  it("enables git on true", () => {
    expect(resolveLastModifiedConfig(true)).toEqual({
      enabled: true,
      source: "git",
    });
  });

  it("honors an explicit source", () => {
    expect(resolveLastModifiedConfig({ type: "frontmatter" })).toEqual({
      enabled: true,
      source: "frontmatter",
    });
  });
});

describe("parseGitLog", () => {
  it("maps each path to its most recent (first-seen) commit date", () => {
    // Mirrors `git log --format=%x00%cI --name-only`: a NUL-prefixed date line,
    // a blank line, then the paths the commit touched, newest commit first.
    const output = [
      dateLine("2026-06-20T10:00:00+00:00"),
      "",
      "docs/a.mdx",
      "docs/b.mdx",
      dateLine("2026-01-01T00:00:00+00:00"),
      "",
      "docs/a.mdx",
      "docs/c.mdx",
    ].join("\n");

    const times = parseGitLog(output);
    // a.mdx appears in both commits; the newer (first-seen) date wins.
    expect(times.get("docs/a.mdx")).toBe("2026-06-20T10:00:00+00:00");
    expect(times.get("docs/b.mdx")).toBe("2026-06-20T10:00:00+00:00");
    expect(times.get("docs/c.mdx")).toBe("2026-01-01T00:00:00+00:00");
  });

  it("ignores blank lines and returns an empty map for empty input", () => {
    expect(parseGitLog("").size).toBe(0);
    expect(parseGitLog("\n\n").size).toBe(0);
  });
});

describe("scanProject lastModified", () => {
  const dirs: string[] = [];

  const makeProject = async (
    files: Record<string, string>
  ): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "blume-lastmod-"));
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

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("does not set lastModified when the feature is off", async () => {
    const root = await makeProject({ "docs/index.md": "# Home\n" });
    const project = await scanProject(root);
    expect(project.manifest.routes[0]?.lastModified).toBeUndefined();
  });

  it("uses the frontmatter date as an override, no git needed", async () => {
    const root = await makeProject({
      "blume.config.ts":
        'export default { lastModified: { type: "frontmatter" } };\n',
      "docs/index.md":
        "---\ntitle: Home\nlastModified: 2020-01-02\n---\n# Home\n",
    });
    const project = await scanProject(root);
    expect(project.manifest.routes[0]?.lastModified).toBe(
      "2020-01-02T00:00:00.000Z"
    );
  });
});
