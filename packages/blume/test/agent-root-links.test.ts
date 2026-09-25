import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildLlmsFiles } from "../src/ai/llms.ts";
import { buildRawMarkdown } from "../src/ai/markdown.ts";
import { relativeLinkRewriter } from "../src/ai/relative-links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";

/**
 * Root-relative links on the agent surfaces get what the rendered page gives
 * them: a page link the `deployment.base` + `basePath` prefix, and — on a page
 * in a prefixed locale — that locale's copy of the route when it is served; a
 * public file or an image the `deployment.base` alone.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scanFixture = async (
  files: Record<string, string>
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-agent-root-links-"));
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

const LINKS = [
  "# Links",
  "",
  "See [Install](/guides/install), [again](/guides/install?tab=npm#top), and [by hand](/docs/guides/install).",
  "Get [the spec](/files/spec.pdf), ![the logo](/logo.png), [elsewhere](https://example.com/x), or [a host](//cdn.example.com/a).",
  "",
  '<Card title="Config" href="/guides/config" />',
  "",
  "`[shown](/guides/install)` stays.",
  "",
  "[ref]: /guides/install",
  "",
].join("\n");

describe("root-relative links under a base path", () => {
  const files = {
    "blume.config.ts":
      'export default { basePath: "/docs", deployment: { base: "/sub" } };',
    "docs/guides/config.md": "# Config\n",
    "docs/guides/install.md": "# Install\n",
    "docs/links.mdx": LINKS,
  };

  it("prefixes them in the Markdown mirrors as the rendered page does", async () => {
    const project = await scanFixture(files);
    const raw = await buildRawMarkdown(project);
    const entry = raw["/docs/links"];
    for (const text of [entry?.mdx ?? "", entry?.md ?? ""]) {
      expect(text).toContain(
        "See [Install](/sub/docs/guides/install), [again](/sub/docs/guides/install?tab=npm#top), and [by hand](/sub/docs/guides/install)."
      );
      expect(text).toContain(
        // A public file and an image gain the deployment base alone, never
        // `basePath`, as the rendered page's do.
        "Get [the spec](/sub/files/spec.pdf), ![the logo](/sub/logo.png), [elsewhere](https://example.com/x), or [a host](//cdn.example.com/a)."
      );
      expect(text).toContain("`[shown](/guides/install)` stays.");
      expect(text).toContain("[ref]: /sub/docs/guides/install");
    }
    expect(entry?.mdx).toContain(
      '<Card title="Config" href="/sub/docs/guides/config" />'
    );
    expect(entry?.md).toContain("**[Config](/sub/docs/guides/config)**");
  });

  it("prefixes them in llms-full.txt", async () => {
    const project = await scanFixture(files);
    const { full } = await buildLlmsFiles(project);
    expect(full).toContain("See [Install](/sub/docs/guides/install)");
  });
});

describe("root-relative links on a translated page", () => {
  const files = {
    "blume.config.ts":
      'export default { i18n: { defaultLocale: "en", fallbackLocale: null, locales: [{ code: "en", label: "English" }, { code: "ja", label: "日本語" }] } };',
    "docs/index.mdx":
      "# Home\n\nRead the [quickstart](/quickstart) and [the English-only page](/only-en).\n",
    "docs/ja/index.mdx":
      "# ホーム\n\n[クイックスタート](/quickstart)と[英語のみ](/only-en)、[英語版](/en/quickstart)。\n",
    "docs/ja/quickstart.mdx": "# クイックスタート\n",
    "docs/only-en.mdx": "# Only English\n",
    "docs/quickstart.mdx": "# Quickstart\n",
  };

  it("moves them into the page's locale where that route is served", async () => {
    const project = await scanFixture(files);
    const raw = await buildRawMarkdown(project);
    // The Japanese page links the Japanese quickstart; the untranslated page
    // (no fallback) and an explicit other-locale link keep their target.
    expect(raw["/ja"]?.mdx).toContain(
      "[クイックスタート](/ja/quickstart)と[英語のみ](/only-en)、[英語版](/en/quickstart)。"
    );
    // The default locale has no prefix, so its page is left as written.
    expect(raw["/"]?.mdx).toContain(
      "Read the [quickstart](/quickstart) and [the English-only page](/only-en)."
    );
  });

  it("leaves a remote page's relative links alone but moves its root links", async () => {
    const project = await scanFixture(files);
    const rewrite = relativeLinkRewriter(project);
    expect(
      rewrite("[a](./quickstart) and [b](/quickstart)", { route: "/ja" })
    ).toBe("[a](./quickstart) and [b](/ja/quickstart)");
  });
});

describe("root-relative links on an unprefixed site", () => {
  it("leaves them as written", async () => {
    const project = await scanFixture({
      "docs/guides/install.md": "# Install\n",
      "docs/links.mdx": LINKS,
    });
    const rewrite = relativeLinkRewriter(project);
    const text = "[Install](/guides/install)\n";
    expect(rewrite(text, { route: "/links" })).toBe(text);
    const raw = await buildRawMarkdown(project);
    expect(raw["/links"]?.mdx).toContain("See [Install](/guides/install),");
  });
});
