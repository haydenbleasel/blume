import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { migrateFumadocs, migrateMintlify } from "../src/migrate/migrate.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-mig-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

describe("migrateMintlify i18n", () => {
  it("maps navigation.languages to an i18n config", async () => {
    const root = await project({
      "docs.json": JSON.stringify({
        name: "Docs",
        navigation: {
          languages: [
            { default: true, groups: [], language: "en" },
            { groups: [], language: "es" },
            { groups: [], language: "fr" },
          ],
        },
      }),
      "es/index.mdx": "# Inicio\n",
      "index.mdx": "# Home\n",
    });

    const result = await migrateMintlify(root);
    const config = await readFile(join(root, "blume.config.ts"), "utf-8");

    expect(config).toContain('"defaultLocale": "en"');
    expect(config).toContain('"code": "es"');
    expect(config).toContain('"code": "fr"');
    // Each locale gets a non-empty display label.
    expect(config).toContain('"label":');
    // Translated content already lives in locale dirs (the dir parser layout).
    expect(result.moved).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("i18n.locales"))).toBe(true);
  });

  it("omits i18n for a single-language project", async () => {
    const root = await project({
      "docs.json": JSON.stringify({ name: "Docs" }),
      "index.mdx": "# Home\n",
    });
    await migrateMintlify(root);
    const config = await readFile(join(root, "blume.config.ts"), "utf-8");
    expect(config).not.toContain("i18n");
  });
});

describe("migrateFumadocs meta", () => {
  it("converts meta.json into a defineMeta meta.ts", async () => {
    const root = await project({
      "content/docs/guides/intro.mdx": "# Intro\n",
      "content/docs/guides/meta.json": JSON.stringify({
        pages: ["intro"],
        title: "Guides",
      }),
    });

    await migrateFumadocs(root);

    const meta = await readFile(
      join(root, "docs", "guides", "meta.ts"),
      "utf-8"
    );
    expect(meta).toContain('import { defineMeta } from "blume"');
    expect(meta).toContain('"title": "Guides"');
    expect(meta).toContain("defineMeta(");
    // The original JSON file is replaced, not left behind.
    expect(existsSync(join(root, "docs", "guides", "meta.json"))).toBe(false);
  });
});
