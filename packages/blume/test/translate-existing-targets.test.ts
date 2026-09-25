import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import type { HeadlessResult } from "../src/eval/agents.ts";
import {
  emptyLedger,
  hashSource,
  stampLedger,
} from "../src/translate/ledger.ts";
import { discoverTranslatableMeta } from "../src/translate/meta.ts";
import { runTranslate } from "../src/translate/run.ts";
import {
  computeWorkList,
  scanForTranslation,
} from "../src/translate/work-list.ts";
import type {
  MetaWorkItem,
  PageWorkItem,
  WorkItem,
} from "../src/translate/work-list.ts";

/**
 * Where a translation run writes. An existing translation is rewritten where
 * it lives — a hand-written `fr/guide.md` for a `guide.mdx` source, a
 * `meta.js` in the locale folder, a `pt-br/` folder for a `pt-BR` locale —
 * instead of gaining a canonical twin beside it. And the meta discovery skips
 * what the scan's own folder-meta discovery skips: excluded application code,
 * and modules that fail to load.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-translate-targets-"));
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

const config = (locale: string, content = "") => `export default {
  title: "Test",${content}
  i18n: {
    defaultLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "${locale}", label: "Other" },
    ],
  },
};
`;

const pageItems = (items: WorkItem[]): PageWorkItem[] =>
  items.filter((item): item is PageWorkItem => item.kind === "page");

const metaItems = (items: WorkItem[]): MetaWorkItem[] =>
  items.filter((item): item is MetaWorkItem => item.kind === "meta");

/** A fake headless claude that answers every call with `result`. */
const replyWith =
  (result: string, prompts: string[] = []) =>
  (
    _bin: string,
    _args: string[],
    options: { prompt: string }
  ): Promise<HeadlessResult> => {
    prompts.push(options.prompt);
    return Promise.resolve({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ is_error: false, result }),
      timedOut: false,
    });
  };

const SOURCE = "---\ntitle: Guide\n---\n# Guide\n\nThe new version.\n";
const HAND_WRITTEN = "---\ntitle: Guide FR\n---\n# Guide\n\nÉcrit à la main.\n";

describe("a stale translation at a non-canonical name", () => {
  it("is rewritten in place, never joined by a canonical twin", async () => {
    const root = await fixture({
      "blume.config.ts": config("fr"),
      "docs/fr/guide.md": HAND_WRITTEN,
      "docs/guide.mdx": SOURCE,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    // The hand-written page was adopted at an older source.
    const ledger = emptyLedger();
    stampLedger(ledger, "docs/guide.mdx", "fr", hashSource("older source"));

    const project = await scanForTranslation(root);
    const workList = await computeWorkList(project, ledger, {
      locales: ["fr"],
    });
    const item = pageItems(workList.items).find(
      (entry) => entry.sourceRel === "docs/guide.mdx"
    );
    expect(item?.status).toBe("stale");
    expect(item?.targetPath).toBe(join(root, "docs/fr/guide.md"));
    expect(item?.targetRel).toBe("docs/fr/guide.md");

    const prompts: string[] = [];
    const result = await runTranslate({
      agent: "claude",
      ledger,
      project,
      run: replyWith(
        "---\ntitle: Guide\n---\n# Guide\n\nLa nouvelle version.\n",
        prompts
      ),
      workList: { ...workList, items: item ? [item] : [] },
    });
    expect(result.counts.translated).toBe(1);
    // The hand-written page was the style precedent, and is what changed.
    expect(prompts[0]).toContain("Écrit à la main.");
    expect(await readFile(join(root, "docs/fr/guide.md"), "utf-8")).toContain(
      "La nouvelle version."
    );
    expect(existsSync(join(root, "docs/fr/guide.mdx"))).toBe(false);

    const rescanned = await scanForTranslation(root);
    expect(
      rescanned.diagnostics.filter(
        (diagnostic) => diagnostic.code === "BLUME_DUPLICATE_ROUTE"
      )
    ).toEqual([]);
  });

  it("still goes to the canonical path when it's missing", async () => {
    const root = await fixture({
      "blume.config.ts": config("fr"),
      "docs/guide.mdx": SOURCE,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const project = await scanForTranslation(root);
    const workList = await computeWorkList(project, emptyLedger());
    expect(pageItems(workList.items).map((entry) => entry.targetRel)).toContain(
      "docs/fr/guide.mdx"
    );
  });
});

describe("a stale hand-written meta.js", () => {
  it("is rewritten instead of gaining a meta.ts beside it", async () => {
    const root = await fixture({
      "blume.config.ts": config("fr"),
      "docs/fr/guides/meta.js": 'export default { title: "Guides FR" };\n',
      "docs/guides/install.mdx": "---\ntitle: Install\n---\n# Install\n",
      "docs/guides/meta.ts": 'export default { order: 1, title: "Guides" };\n',
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const ledger = emptyLedger();
    stampLedger(ledger, "docs/guides/meta.ts", "fr", hashSource("older"));

    const project = await scanForTranslation(root);
    const workList = await computeWorkList(project, ledger);
    const [meta] = metaItems(workList.items);
    expect(
      meta?.entries.map((entry) => [entry.status, entry.targetPath])
    ).toEqual([["stale", join(root, "docs/fr/guides/meta.js")]]);

    await runTranslate({
      agent: "claude",
      ledger,
      project,
      run: replyWith(JSON.stringify({ "docs/guides": "Les guides" })),
      workList: { ...workList, items: meta ? [meta] : [] },
    });
    expect(
      await readFile(join(root, "docs/fr/guides/meta.js"), "utf-8")
    ).toContain('title: "Les guides"');
    expect(existsSync(join(root, "docs/fr/guides/meta.ts"))).toBe(false);
  });
});

describe("a locale folder authored in another casing", () => {
  it("receives the locale's meta, like its pages", async () => {
    const root = await fixture({
      "blume.config.ts": config("pt-BR"),
      "docs/guides/install.mdx": "---\ntitle: Install\n---\n# Install\n",
      "docs/guides/meta.ts": 'export default { title: "Guides" };\n',
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
      "docs/pt-br/index.mdx": "---\ntitle: Início\n---\n# Início\n",
    });
    const project = await scanForTranslation(root);
    const workList = await computeWorkList(project, emptyLedger());

    expect(pageItems(workList.items).map((entry) => entry.targetRel)).toContain(
      "docs/pt-br/guides/install.mdx"
    );
    expect(
      metaItems(workList.items).flatMap((item) =>
        item.entries.map((entry) => entry.targetPath)
      )
    ).toEqual([join(root, "docs/pt-br/guides/meta.ts")]);
  });
});

describe("meta discovery scope", () => {
  const PROJECT = {
    "blume.config.ts": config(
      "fr",
      '\n  content: { root: ".", exclude: ["src/**"] },'
    ),
    "guides/intro.md": "---\ntitle: Intro\n---\n# Intro\n",
    "guides/meta.ts": 'export default { title: "Guides" };\n',
    "index.md": "---\ntitle: Home\n---\n# Home\n",
  };

  it("skips a meta.ts under the source's excluded folders", async () => {
    const root = await fixture({
      ...PROJECT,
      // Application code whose import only resolves inside its own app.
      "src/lib/meta.ts":
        'import { title } from "./does-not-exist";\nexport default { title };\n',
    });
    const project = await scanForTranslation(root);
    const { metas } = await discoverTranslatableMeta(project);
    expect(metas.map((meta) => meta.sourceRel)).toEqual(["guides/meta.ts"]);
  });

  it("moves past folder meta that fails to load", async () => {
    const root = await fixture({
      ...PROJECT,
      // The scan reports this one as BLUME_META_LOAD_FAILED.
      "notes/meta.ts": 'throw new Error("broken meta");\n',
      "notes/page.md": "---\ntitle: Notes\n---\n# Notes\n",
    });
    const project = await scanForTranslation(root);
    expect(project.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "BLUME_META_LOAD_FAILED"
    );
    const { metas } = await discoverTranslatableMeta(project);
    expect(metas.map((meta) => meta.sourceRel)).toEqual(["guides/meta.ts"]);
  });
});
