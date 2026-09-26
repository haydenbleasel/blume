import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join, relative } from "pathe";

import { localeTargetPath } from "../src/core/i18n.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { ResolvedI18nConfig } from "../src/core/schema.ts";
import { emptyLedger } from "../src/translate/ledger.ts";
import { computeWorkList } from "../src/translate/work-list.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
});

const i18nFor = (parser: "dir" | "dot"): ResolvedI18nConfig => ({
  defaultLocale: "en",
  fallbackLocale: undefined,
  hideDefaultLocalePrefix: true,
  locales: [
    { code: "en", dir: "ltr", label: "English" },
    { code: "pt-BR", dir: "ltr", label: "Português" },
  ],
  parser,
  routeByBrowserLanguage: false,
});

describe("localeTargetPath locale folder casing", () => {
  it("reuses a locale folder authored in another casing", () => {
    expect(
      localeTargetPath("guides/x.mdx", ".mdx", "pt-BR", i18nFor("dir"), [
        "guides",
        "pt-br",
      ])
    ).toBe("pt-br/guides/x.mdx");
  });

  it("prefers the configured casing when that folder exists too", () => {
    expect(
      localeTargetPath("x.mdx", ".mdx", "pt-BR", i18nFor("dir"), [
        "pt-br",
        "pt-BR",
      ])
    ).toBe("pt-BR/x.mdx");
  });

  it("writes the configured casing when no locale folder exists yet", () => {
    expect(
      localeTargetPath("x.mdx", ".mdx", "pt-BR", i18nFor("dir"), ["guides"])
    ).toBe("pt-BR/x.mdx");
    expect(localeTargetPath("x.mdx", ".mdx", "pt-BR", i18nFor("dir"))).toBe(
      "pt-BR/x.mdx"
    );
  });

  it("leaves the dot parser's suffix alone", () => {
    expect(
      localeTargetPath("x.mdx", ".mdx", "pt-BR", i18nFor("dot"), ["pt-br"])
    ).toBe("x.pt-BR.mdx");
  });
});

describe("blume translate into a lowercase locale folder", () => {
  it("targets the folder the locale's pages already live in", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-locale-casing-"));
    dirs.push(root);
    const files = {
      "blume.config.ts": `export default {
  i18n: {
    defaultLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "pt-BR", label: "Português" },
    ],
  },
};
`,
      "docs/guide.mdx": "---\ntitle: Guide\n---\n# Guide\n",
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
      "docs/pt-br/index.mdx": "---\ntitle: Início\n---\n# Início\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([rel, content]) => {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await writeFile(join(root, rel), content);
      })
    );
    const project = await scanProject(root, { mode: "build" });
    const { items } = await computeWorkList(project, emptyLedger(), {
      force: true,
    });
    const targets = items.flatMap((item) =>
      item.kind === "page" ? [relative(root, item.targetPath)] : []
    );
    expect(targets.toSorted()).toStrictEqual([
      "docs/pt-br/guide.mdx",
      "docs/pt-br/index.mdx",
    ]);
  });
});
