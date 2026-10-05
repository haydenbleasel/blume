import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildRawMarkdown, markdownRoutePaths } from "../src/ai/markdown.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scanFixture = async (
  files: Record<string, string>
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-changelog-md-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return await scanProject(root);
};

const entry = (front: string, body = "Notes.") =>
  `---\ntype: changelog\n${front}\n---\n\n${body}\n`;

const RELEASES = {
  "docs/changelog/draft.md": entry(
    "title: Draft\ndate: 2026-10-01\ndraft: true"
  ),
  "docs/changelog/hidden.md": entry(
    "title: Hidden\ndate: 2026-10-02\nsidebar:\n  hidden: true"
  ),
  "docs/changelog/undated.md": entry("title: Someday"),
  "docs/changelog/v1.md": entry("title: v1.0 [beta]\ndate: 2025-01-15"),
  "docs/changelog/v2-1.md": entry("title: v2.1\ndate: 2026-10-05"),
  "docs/changelog/v2.md": entry(
    "title: v2.0\nchangelog:\n  category: Major\n  date: 2026-09-24"
  ),
  "docs/index.md": "# Home\n",
};

describe("the generated changelog index mirror", () => {
  it("lists the visible releases newest first, grouped by year", async () => {
    const project = await scanFixture({
      ...RELEASES,
      "blume.config.ts":
        'export default { deployment: { site: "https://docs.example.com" } };',
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/changelog"]?.mdx).toBe(
      [
        "# Changelog",
        "",
        "Product updates, new features, and fixes from every release.",
        "",
        "## 2026",
        "",
        "- [v2.1](https://docs.example.com/changelog/v2-1) — 2026-10-05",
        "- [v2.0](https://docs.example.com/changelog/v2) — 2026-09-24, Major",
        "",
        "## 2025",
        "",
        "- [v1.0 \\[beta\\]](https://docs.example.com/changelog/v1) — 2025-01-15",
        "",
        "## Undated",
        "",
        "- [Someday](https://docs.example.com/changelog/undated)",
        "",
      ].join("\n")
    );
    expect(markdownRoutePaths(project)).toContain("/changelog");
  });

  it("lists only the default locale's releases, in its own words", async () => {
    const project = await scanFixture({
      "blume.config.ts": `export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }], ui: { en: { changelog: { description: "What shipped.", title: "Releases" } } } } };`,
      "docs/changelog/v2.md": entry("title: v2.0\ndate: 2026-09-24"),
      "docs/fr/changelog/v2.md": entry("title: v2.0 (fr)\ndate: 2026-09-24"),
      "docs/index.md": "# Home\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/changelog"]?.mdx).toBe(
      "# Releases\n\nWhat shipped.\n\n## 2026\n\n- [v2.0](/changelog/v2) — 2026-09-24\n"
    );
  });

  it("takes its title and description from the changelog config", async () => {
    const project = await scanFixture({
      "blume.config.ts": `export default { changelog: { description: "Every Acme release.", title: "Release notes" } };`,
      "docs/changelog/v2.md": entry("title: v2.0\ndate: 2026-09-24"),
      "docs/index.md": "# Home\n",
    });
    const raw = await buildRawMarkdown(project);
    expect(raw["/changelog"]?.mdx).toBe(
      "# Release notes\n\nEvery Acme release.\n\n## 2026\n\n- [v2.0](/changelog/v2) — 2026-09-24\n"
    );
  });

  it("reads a per-locale changelog config in the default locale, over i18n.ui", async () => {
    const project = await scanFixture({
      "blume.config.ts": `export default { changelog: { title: { de: "Versionshinweise", en: "Release notes" } }, i18n: { defaultLocale: "en", locales: [{ code: "de", label: "Deutsch" }, { code: "en", label: "English" }], ui: { en: { changelog: { description: "What shipped.", title: "Releases" } } } } };`,
      "docs/changelog/v2.md": entry("title: v2.0\ndate: 2026-09-24"),
      "docs/index.md": "# Home\n",
    });
    const raw = await buildRawMarkdown(project);
    // The title is the config's English entry; the unset description stays
    // the i18n.ui override.
    expect(raw["/changelog"]?.mdx).toBe(
      "# Release notes\n\nWhat shipped.\n\n## 2026\n\n- [v2.0](/changelog/v2) — 2026-09-24\n"
    );
  });

  it("leaves a changelog the project serves itself alone", async () => {
    const owned = await scanFixture({
      ...RELEASES,
      "docs/changelog/index.md": "# Our changelog\n",
    });
    const ownedRaw = await buildRawMarkdown(owned);
    expect(ownedRaw["/changelog"]?.mdx).toContain("# Our changelog");

    const custom = await scanFixture({
      ...RELEASES,
      "pages/changelog.astro": "---\n---\n<h1>Custom</h1>\n",
    });
    const customRaw = await buildRawMarkdown(custom);
    expect(customRaw["/changelog"]).toBeUndefined();
    expect(markdownRoutePaths(custom)).not.toContain("/changelog");
  });

  it("has nothing to mirror on a site without a changelog", async () => {
    const project = await scanFixture({ "docs/index.md": "# Home\n" });
    const raw = await buildRawMarkdown(project);
    expect(raw["/changelog"]).toBeUndefined();
    expect(markdownRoutePaths(project)).toStrictEqual(["/"]);
  });
});
