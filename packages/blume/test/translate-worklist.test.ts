import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import {
  emptyLedger,
  hashSource,
  stampLedger,
} from "../src/translate/ledger.ts";
import {
  discoverTranslatableMeta,
  generateMetaModule,
} from "../src/translate/meta.ts";
import { computeWorkList } from "../src/translate/work-list.ts";
import type { MetaWorkItem, PageWorkItem } from "../src/translate/work-list.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const CONFIG = `export default {
  title: "Test",
  i18n: {
    defaultLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "fr", label: "French" },
      { code: "de", label: "German" },
    ],
  },
};
`;

const FILES: Record<string, string> = {
  "blume.config.ts": CONFIG,
  "docs/changelog.$.mdx": "---\ntitle: Changelog\n---\n# Changelog\n",
  "docs/concepts/meta.ts": "export default { order: 2 };\n",
  "docs/fr/guides/meta.ts": 'export default { title: "Guides FR" };\n',
  "docs/fr/index.mdx": "---\ntitle: Accueil\n---\n# Accueil\n",
  "docs/guides/install.mdx": "---\ntitle: Install\n---\n# Install\n",
  "docs/guides/meta.ts": 'export default { order: 1, title: "Guides" };\n',
  "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
  "docs/legal/meta.ts": 'export default () => ({ title: "Legal" });\n',
};

const fixture = async (
  files: Record<string, string> = FILES
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-translate-work-"));
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

const scan = (root: string): Promise<BlumeProject> =>
  scanProject(root, { mode: "build" });

const pageItems = (items: (PageWorkItem | MetaWorkItem)[]): PageWorkItem[] =>
  items.filter((item): item is PageWorkItem => item.kind === "page");

const metaItems = (items: (PageWorkItem | MetaWorkItem)[]): MetaWorkItem[] =>
  items.filter((item): item is MetaWorkItem => item.kind === "meta");

describe("computeWorkList", () => {
  it("never translates archived-version snapshots", async () => {
    const root = await fixture({
      ...FILES,
      "blume.config.ts": `export default {
  title: "Test",
  i18n: {
    defaultLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "fr", label: "French" },
      { code: "de", label: "German" },
    ],
  },
  versions: {
    archived: [{ id: "v1.0" }],
    current: { label: "v2.0" },
  },
};
`,
      // A frozen snapshot with a missing French translation: still not work.
      "docs/v1.0/guides/install.mdx": "---\ntitle: Install v1\n---\n# Old\n",
    });
    const project = await scan(root);
    const workList = await computeWorkList(project, emptyLedger());
    const sources = pageItems(workList.items).map((item) => item.sourceRel);
    expect(sources).toContain("docs/guides/install.mdx");
    expect(sources.some((rel) => rel.includes("v1.0"))).toBe(false);
  });

  it("classifies missing, untracked, and excluded sources across locales", async () => {
    const root = await fixture();
    const project = await scan(root);
    const workList = await computeWorkList(project, emptyLedger());

    expect(workList.targetLocales).toEqual(["fr", "de"]);
    // Pages sorted by (sourceRel, locale); the shared `.$.` file is excluded.
    expect(
      pageItems(workList.items).map((item) => [
        item.sourceRel,
        item.locale,
        item.status,
      ])
    ).toEqual([
      ["docs/guides/install.mdx", "de", "missing"],
      ["docs/guides/install.mdx", "fr", "missing"],
      ["docs/index.mdx", "de", "missing"],
    ]);
    // Canonical dir-parser target paths.
    const install = pageItems(workList.items)[1] as PageWorkItem;
    expect(install.targetRel).toBe("docs/fr/guides/install.mdx");
    expect(install.targetPath).toBe(join(root, "docs/fr/guides/install.mdx"));

    // The hand-authored fr/index.mdx and fr/guides/meta.ts are adopted, never
    // overwritten.
    expect(
      workList.untracked.map((entry) => [
        entry.sourceRel,
        entry.locale,
        entry.kind,
      ])
    ).toEqual([
      ["docs/index.mdx", "fr", "page"],
      ["docs/guides/meta.ts", "fr", "meta"],
    ]);

    // Meta: only the titled, object-form, default-locale meta file, and only
    // the locale with no existing translation; batched one item per locale.
    const meta = metaItems(workList.items);
    expect(meta).toHaveLength(1);
    expect(meta[0]?.locale).toBe("de");
    expect(meta[0]?.entries.map((entry) => entry.meta.sourceRel)).toEqual([
      "docs/guides/meta.ts",
    ]);
    expect(meta[0]?.entries[0]?.status).toBe("missing");
    expect(meta[0]?.entries[0]?.targetPath).toBe(
      join(root, "docs/de/guides/meta.ts")
    );

    // The factory-form meta file is diagnosed, the title-less one is skipped.
    expect(workList.diagnostics.map((d) => d.code)).toEqual([
      "BLUME_TRANSLATE_META_FACTORY",
    ]);
    expect(workList.upToDate).toBe(0);
    expect([...workList.knownSources].toSorted()).toEqual([
      "docs/guides/install.mdx",
      "docs/guides/meta.ts",
      "docs/index.mdx",
    ]);
  });

  it("treats matching ledger stamps as up to date and mismatches as stale", async () => {
    const root = await fixture();
    const project = await scan(root);
    const ledger = emptyLedger();
    const indexHash = hashSource(
      await readFile(join(root, "docs/index.mdx"), "utf-8")
    );
    const metaHash = hashSource(
      await readFile(join(root, "docs/guides/meta.ts"), "utf-8")
    );
    stampLedger(ledger, "docs/index.mdx", "fr", indexHash);
    stampLedger(ledger, "docs/guides/meta.ts", "fr", metaHash);

    const current = await computeWorkList(project, ledger);
    expect(current.untracked).toEqual([]);
    expect(current.upToDate).toBe(2);

    stampLedger(ledger, "docs/index.mdx", "fr", "0000000000000000");
    const drifted = await computeWorkList(project, ledger);
    const stale = pageItems(drifted.items).find(
      (item) => item.sourceRel === "docs/index.mdx" && item.locale === "fr"
    );
    expect(stale?.status).toBe("stale");
    expect(stale?.targetRel).toBe("docs/fr/index.mdx");
    expect(drifted.upToDate).toBe(1);
  });

  it("narrows targets with --locale and promotes everything with --force", async () => {
    const root = await fixture();
    const project = await scan(root);
    const ledger = emptyLedger();
    const indexHash = hashSource(
      await readFile(join(root, "docs/index.mdx"), "utf-8")
    );
    stampLedger(ledger, "docs/index.mdx", "fr", indexHash);

    const narrowed = await computeWorkList(project, ledger, {
      locales: ["fr"],
    });
    expect(narrowed.targetLocales).toEqual(["fr"]);
    expect(narrowed.items.every((item) => item.locale === "fr")).toBe(true);
    expect(narrowed.upToDate).toBe(1);

    const forced = await computeWorkList(project, ledger, { force: true });
    // Up-to-date and untracked pairs are promoted to stale work; missing stays
    // missing.
    expect(forced.untracked).toEqual([]);
    expect(forced.upToDate).toBe(0);
    const index = pageItems(forced.items).filter(
      (item) => item.sourceRel === "docs/index.mdx"
    );
    expect(index.map((item) => [item.locale, item.status])).toEqual([
      ["de", "missing"],
      ["fr", "stale"],
    ]);
    const meta = metaItems(forced.items);
    expect(meta.map((item) => item.locale)).toEqual(["de", "fr"]);
    expect(meta[1]?.entries[0]?.status).toBe("stale");
  });

  it("forces unstamped pages to stale and marks drifted meta stamps stale", async () => {
    const root = await fixture();
    const project = await scan(root);
    const ledger = emptyLedger();
    // A meta stamp that no longer matches the source hash is stale on its own.
    stampLedger(ledger, "docs/guides/meta.ts", "fr", "0000000000000000");

    const forced = await computeWorkList(project, ledger, { force: true });
    // The hand-authored fr/index.mdx has no ledger stamp; under --force it is
    // retranslated as stale instead of being adopted as untracked.
    const index = pageItems(forced.items).find(
      (item) => item.sourceRel === "docs/index.mdx" && item.locale === "fr"
    );
    expect(index?.status).toBe("stale");
    expect(forced.untracked).toEqual([]);
    const meta = metaItems(forced.items).find((item) => item.locale === "fr");
    expect(meta?.entries[0]?.status).toBe("stale");
  });

  it("targets dot-parser suffix paths and skips meta translation entirely", async () => {
    const root = await fixture({
      "blume.config.ts": CONFIG.replace(
        'defaultLocale: "en",',
        'defaultLocale: "en",\n    parser: "dot",'
      ),
      "docs/guides/meta.ts": 'export default { title: "Guides" };\n',
      "docs/intro.fr.mdx": "---\ntitle: Intro FR\n---\n# Intro FR\n",
      "docs/intro.mdx": "---\ntitle: Intro\n---\n# Intro\n",
    });
    const project = await scan(root);
    const workList = await computeWorkList(project, emptyLedger());

    // Under `dot` there is no per-locale meta mechanism: no meta items even
    // though a titled meta.ts exists.
    expect(metaItems(workList.items)).toEqual([]);
    expect(
      pageItems(workList.items).map((item) => [item.targetRel, item.status])
    ).toEqual([["docs/intro.de.mdx", "missing"]]);
    expect(workList.untracked.map((entry) => entry.locale)).toEqual(["fr"]);
  });

  it("returns an empty work list when i18n is not configured", async () => {
    const root = await fixture({
      "blume.config.ts": 'export default { title: "Test" };\n',
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const project = await scan(root);
    const workList = await computeWorkList(project, emptyLedger());
    expect(workList.items).toEqual([]);
    expect(workList.targetLocales).toEqual([]);
    expect(workList.upToDate).toBe(0);
  });

  it("excludes staged, remote, and non-markdown pages from the universe", async () => {
    const root = await fixture();
    const project = await scan(root);
    const txtPath = join(root, "docs/raw.txt");
    await writeFile(txtPath, "not markdown");
    const doctored = {
      ...project,
      graph: {
        ...project.graph,
        pages: [
          ...project.graph.pages,
          // A staged/remote page (no writable path) and a non-markdown one.
          {
            ...project.graph.pages[0],
            id: "cms:remote",
            source: { name: "cms", ref: "remote" },
            sourcePath: undefined,
            translationKey: "/remote",
          },
          {
            ...project.graph.pages[0],
            id: "filesystem:raw.txt",
            source: { name: "filesystem", ref: "raw.txt" },
            sourcePath: txtPath,
            translationKey: "/raw",
          },
          // A page whose source has no content root (e.g. staged).
          {
            ...project.graph.pages[0],
            id: "ghost:page.mdx",
            source: { name: "ghost", ref: "page.mdx" },
            sourcePath: join(root, "elsewhere/page.mdx"),
            translationKey: "/ghost",
          },
        ],
      },
      sources: [
        ...project.sources,
        {
          load: () => Promise.resolve({ diagnostics: [], entries: [] }),
          name: "cms",
          staged: true,
        },
      ],
    } as BlumeProject;
    const workList = await computeWorkList(doctored, emptyLedger());
    const rels = new Set(
      pageItems(workList.items).map((item) => item.sourceRel)
    );
    expect(rels).toEqual(
      new Set(["docs/index.mdx", "docs/guides/install.mdx"])
    );
  });
});

describe("discoverTranslatableMeta", () => {
  it("returns nothing for a project without i18n", async () => {
    const root = await fixture({
      "blume.config.ts": 'export default { title: "Test" };\n',
      "docs/guides/meta.ts": 'export default { title: "Guides" };\n',
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const project = await scan(root);
    expect(await discoverTranslatableMeta(project)).toEqual({
      diagnostics: [],
      metas: [],
    });
  });

  it("skips invalid meta modules without a diagnostic of its own", async () => {
    const root = await fixture({
      ...FILES,
      "docs/broken/meta.ts": 'export default { title: 42, bogus: "x" };\n',
    });
    const project = await scan(root);
    const { metas } = await discoverTranslatableMeta(project);
    expect(metas.map((meta) => meta.sourceRel)).toEqual([
      "docs/guides/meta.ts",
    ]);
    expect(metas[0]?.dir).toBe("guides");
    expect(metas[0]?.title).toBe("Guides");
    expect(metas[0]?.raw).toContain("Guides");
  });
});

describe("generateMetaModule", () => {
  it("copies every source key with only the title translated, keys sorted", () => {
    const module_ = generateMetaModule(
      {
        collapsed: true,
        order: 2,
        pages: ["install", "usage"],
        title: "Guides",
      },
      "Guides FR"
    );
    expect(module_).toBe(
      [
        "// Generated by `blume translate` — edit the default locale's meta file",
        "// and rerun the translation instead of editing this copy.",
        "export default {",
        "  collapsed: true,",
        "  order: 2,",
        '  pages: ["install","usage"],',
        '  title: "Guides FR",',
        "};",
        "",
      ].join("\n")
    );
  });

  it("omits undefined keys", () => {
    const module_ = generateMetaModule({ title: "Legal" }, "Légal");
    expect(module_).toContain('  title: "Légal",');
    expect(module_).not.toContain("order");
    expect(module_).not.toContain("undefined");
  });
});
