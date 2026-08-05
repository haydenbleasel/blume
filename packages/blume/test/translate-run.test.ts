import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { dirname, join } from "pathe";

import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { HeadlessOptions, HeadlessResult } from "../src/eval/agents.ts";
import { emptyLedger, hashSource } from "../src/translate/ledger.ts";
import type { TranslatableMeta } from "../src/translate/meta.ts";
import { runTranslate } from "../src/translate/run.ts";
import type { TranslateProgress } from "../src/translate/run.ts";
import type {
  MetaWorkItem,
  PageWorkItem,
  TranslateWorkList,
} from "../src/translate/work-list.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-translate-run-"));
  dirs.push(dir);
  return dir;
};

const project = (root: string): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      i18n: {
        defaultLocale: "en",
        locales: [
          { code: "en", label: "English" },
          { code: "fr", label: "French" },
        ],
      },
      title: "Test",
    }),
    context: { root },
  }) as BlumeProject;

const SOURCE = "---\ntitle: Home\n---\n# Home\n\nWelcome.\n";
const TRANSLATED = "---\ntitle: Accueil\n---\n# Accueil\n\nBienvenue.\n";

const pageItem = async (
  root: string,
  name = "index"
): Promise<PageWorkItem> => {
  const sourcePath = join(root, `docs/${name}.mdx`);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, SOURCE);
  return {
    kind: "page",
    locale: "fr",
    sourcePath,
    sourceRel: `docs/${name}.mdx`,
    status: "missing",
    targetPath: join(root, `docs/fr/${name}.mdx`),
    targetRel: `docs/fr/${name}.mdx`,
  };
};

const workListOf = (
  items: (MetaWorkItem | PageWorkItem)[]
): TranslateWorkList => ({
  diagnostics: [],
  items,
  knownSources: new Set(),
  targetLocales: ["fr"],
  untracked: [],
  upToDate: 0,
});

interface RecordedCall {
  args: string[];
  bin: string;
  options: HeadlessOptions;
}

const args0LastMessage = (call: RecordedCall): string =>
  call.args[call.args.indexOf("--output-last-message") + 1] as string;

const notFoundRunner = (): Promise<HeadlessResult> =>
  Promise.resolve({ code: 9009, stderr: "", stdout: "", timedOut: false });

/** A fake claude: replies with a canned envelope per call, records argv. */
const claudeRunner = (
  replies: { result: string; costUsd?: number; isError?: boolean }[]
): {
  calls: RecordedCall[];
  run: (
    bin: string,
    args: string[],
    options: HeadlessOptions
  ) => Promise<HeadlessResult>;
} => {
  const calls: RecordedCall[] = [];
  return {
    calls,
    run: (bin, args, options) => {
      const reply = replies[calls.length] ?? { result: "" };
      calls.push({ args, bin, options });
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          is_error: reply.isError ?? false,
          result: reply.result,
          ...(reply.costUsd === undefined
            ? {}
            : { total_cost_usd: reply.costUsd }),
        }),
        timedOut: false,
      });
    },
  };
};

describe("runTranslate pages", () => {
  it("writes, stamps, aggregates cost, and orders progress events", async () => {
    const root = await scratch();
    const items = [await pageItem(root, "a"), await pageItem(root, "b")];
    const ledger = emptyLedger();
    const events: TranslateProgress[] = [];
    const { calls, run } = claudeRunner([
      { costUsd: 0.1, result: TRANSLATED },
      { costUsd: 0.25, result: TRANSLATED },
    ]);

    const result = await runTranslate({
      agent: "claude",
      ledger,
      onProgress: (event) => events.push(event),
      project: project(root),
      run,
      timeoutMs: 42_000,
      workList: workListOf(items),
    });

    expect(result.counts).toEqual({ failed: 0, partial: 0, translated: 2 });
    expect(result.costUsd).toBeCloseTo(0.35);
    expect(result.diagnostics).toEqual([]);
    expect(await readFile(join(root, "docs/fr/a.mdx"), "utf-8")).toContain(
      "# Accueil"
    );
    expect(ledger.files["docs/a.mdx"]).toEqual({ fr: hashSource(SOURCE) });
    expect(ledger.files["docs/b.mdx"]).toEqual({ fr: hashSource(SOURCE) });

    // The prompt carries the source file and both locale names; the timeout
    // propagates to every spawn.
    expect(calls[0]?.options.prompt).toContain("# Home");
    expect(calls[0]?.options.prompt).toContain("French (fr)");
    expect(calls.every((call) => call.options.timeoutMs === 42_000)).toBe(true);
    expect(calls[0]?.bin).toBe("claude");

    expect(events.map((event) => event.kind)).toEqual([
      "item-start",
      "item-end",
      "item-start",
      "item-end",
    ]);
  });

  it("runs lanes concurrently, keeps results ordered, and persists after each item", async () => {
    const root = await scratch();
    const items = await Promise.all(
      ["a", "b", "c", "d"].map((name) => pageItem(root, name))
    );
    const ledger = emptyLedger();
    let inFlight = 0;
    let peak = 0;
    const run = async (): Promise<HeadlessResult> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Hold the lane long enough for the others to start.
      await delay(25);
      inFlight -= 1;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ is_error: false, result: TRANSLATED }),
        timedOut: false,
      };
    };
    let persists = 0;
    const events: TranslateProgress[] = [];

    const result = await runTranslate({
      agent: "claude",
      concurrency: 4,
      ledger,
      onProgress: (event) => events.push(event),
      persistLedger: () => {
        persists += 1;
        return Promise.resolve();
      },
      project: project(root),
      run,
      workList: workListOf(items),
    });

    expect(peak).toBeGreaterThan(1);
    expect(result.counts.translated).toBe(4);
    // Results stay indexed by work item, regardless of completion order.
    expect(
      result.results.map((r) => (r.item as PageWorkItem).sourceRel)
    ).toEqual(items.map((item) => item.sourceRel));
    // The ledger was flushed once per finished item, and every item stamped.
    expect(persists).toBe(4);
    for (const item of items) {
      expect(ledger.files[item.sourceRel]).toEqual({ fr: hashSource(SOURCE) });
    }
    expect(events.filter((e) => e.kind === "item-start")).toHaveLength(4);
    expect(events.filter((e) => e.kind === "item-end")).toHaveLength(4);
  });

  it("sends the existing translation for a stale item, none for a missing one", async () => {
    const root = await scratch();
    const stale: PageWorkItem = {
      ...(await pageItem(root, "stale")),
      status: "stale",
    };
    await mkdir(dirname(stale.targetPath), { recursive: true });
    await writeFile(stale.targetPath, TRANSLATED);
    const fresh = await pageItem(root, "fresh");
    const { calls, run } = claudeRunner([
      { result: TRANSLATED },
      { result: TRANSLATED },
    ]);

    const result = await runTranslate({
      agent: "claude",
      concurrency: 1,
      ledger: emptyLedger(),
      project: project(root),
      run,
      workList: workListOf([stale, fresh]),
    });

    expect(result.counts.translated).toBe(2);
    expect(calls[0]?.options.prompt).toContain("previous translation");
    expect(calls[0]?.options.prompt).toContain("Bienvenue.");
    expect(calls[1]?.options.prompt).not.toContain("previous translation");
  });

  it("continues after a validation failure without writing or stamping", async () => {
    const root = await scratch();
    const items = [await pageItem(root, "bad"), await pageItem(root, "good")];
    const ledger = emptyLedger();
    // First reply drops the frontmatter; second is fine.
    const { run } = claudeRunner([
      { result: "# Accueil\n\nBonjour.\n" },
      { result: TRANSLATED },
    ]);

    const result = await runTranslate({
      agent: "claude",
      ledger,
      project: project(root),
      run,
      workList: workListOf(items),
    });

    expect(result.counts).toEqual({ failed: 1, partial: 0, translated: 1 });
    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[0]?.detail).toContain("frontmatter");
    expect(existsSync(join(root, "docs/fr/bad.mdx"))).toBe(false);
    expect(ledger.files["docs/bad.mdx"]).toBeUndefined();
    expect(ledger.files["docs/good.mdx"]).toBeDefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "BLUME_TRANSLATE_FAILED",
    ]);
    expect(result.diagnostics[0]?.message).toContain("docs/bad.mdx");
  });

  it("reads the codex last-message file and reports no cost", async () => {
    const root = await scratch();
    const items = [await pageItem(root)];
    const ledger = emptyLedger();
    const calls: RecordedCall[] = [];
    const run = async (
      bin: string,
      args: string[],
      options: HeadlessOptions
    ): Promise<HeadlessResult> => {
      calls.push({ args, bin, options });
      const messagePath = args[
        args.indexOf("--output-last-message") + 1
      ] as string;
      await writeFile(messagePath, TRANSLATED);
      return { code: 0, stderr: "progress noise", stdout: "", timedOut: false };
    };

    const result = await runTranslate({
      agent: "codex",
      ledger,
      project: project(root),
      run,
      workList: workListOf(items),
    });

    expect(result.counts.translated).toBe(1);
    expect(result.costUsd).toBeUndefined();
    expect(calls[0]?.bin).toBe("codex");
    // The per-call last-message file is indexed and lives in the run temp dir.
    expect(calls[0]?.args).toContain("--output-last-message");
    expect(calls[0]?.options.cwd).toBe(
      dirname(args0LastMessage(calls[0] as RecordedCall))
    );
  });

  it("surfaces an agent error as a failed item with its detail", async () => {
    const root = await scratch();
    const items = [await pageItem(root)];
    const { run } = claudeRunner([{ isError: true, result: "quota" }]);
    const result = await runTranslate({
      agent: "claude",
      ledger: emptyLedger(),
      project: project(root),
      run,
      workList: workListOf(items),
    });
    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[0]?.detail).toBe("agent failed");
  });

  it("rejects with ENOENT when a shell launch reports code 9009", async () => {
    const root = await scratch();
    const items = [await pageItem(root)];
    await expect(
      runTranslate({
        agent: "claude",
        ledger: emptyLedger(),
        project: project(root),
        run: notFoundRunner,
        workList: workListOf(items),
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws when the project has no i18n config", async () => {
    const root = await scratch();
    const bare = { config: {}, context: { root } } as BlumeProject;
    await expect(
      runTranslate({
        agent: "claude",
        ledger: emptyLedger(),
        project: bare,
        workList: workListOf([]),
      })
    ).rejects.toThrow("requires i18n");
  });
});

const metaOf = (
  root: string,
  dir: string,
  title: string
): TranslatableMeta => ({
  contentRoot: join(root, "docs"),
  data: { order: 1, title },
  dir,
  file: join(root, "docs", dir, "meta.ts"),
  raw: `export default { order: 1, title: ${JSON.stringify(title)} };\n`,
  sourceRel: dir === "" ? "docs/meta.ts" : `docs/${dir}/meta.ts`,
  title,
});

const metaItem = (root: string, metas: TranslatableMeta[]): MetaWorkItem => ({
  entries: metas.map((meta) => ({
    meta,
    status: "missing",
    targetPath: join(meta.contentRoot, "fr", meta.dir, "meta.ts"),
  })),
  kind: "meta",
  locale: "fr",
});

describe("runTranslate meta", () => {
  it("writes every generated module and stamps each entry on full success", async () => {
    const root = await scratch();
    const ledger = emptyLedger();
    const item = metaItem(root, [
      metaOf(root, "guides", "Guides"),
      metaOf(root, "reference", "Reference"),
    ]);
    const { calls, run } = claudeRunner([
      { result: '{"guides": "Guides FR", "reference": "Référence"}' },
    ]);

    const result = await runTranslate({
      agent: "claude",
      ledger,
      project: project(root),
      run,
      workList: workListOf([item]),
    });

    expect(result.counts).toEqual({ failed: 0, partial: 0, translated: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.prompt).toContain('"guides": "Guides"');
    const guides = await readFile(
      join(root, "docs/fr/guides/meta.ts"),
      "utf-8"
    );
    expect(guides).toContain('title: "Guides FR"');
    expect(guides).toContain("order: 1");
    expect(guides).toContain("Generated by `blume translate`");
    expect(ledger.files["docs/guides/meta.ts"]?.fr).toBeDefined();
    expect(ledger.files["docs/reference/meta.ts"]?.fr).toBeDefined();
  });

  it("lands the usable titles and reports the rest as a partial batch", async () => {
    const root = await scratch();
    const ledger = emptyLedger();
    const item = metaItem(root, [
      metaOf(root, "guides", "Guides"),
      metaOf(root, "reference", "Reference"),
    ]);
    const { run } = claudeRunner([{ result: '{"guides": "Guides FR"}' }]);

    const result = await runTranslate({
      agent: "claude",
      ledger,
      project: project(root),
      run,
      workList: workListOf([item]),
    });

    expect(result.counts).toEqual({ failed: 0, partial: 1, translated: 0 });
    expect(result.results[0]?.detail).toContain("reference");
    expect(existsSync(join(root, "docs/fr/guides/meta.ts"))).toBe(true);
    expect(existsSync(join(root, "docs/fr/reference/meta.ts"))).toBe(false);
    expect(ledger.files["docs/guides/meta.ts"]?.fr).toBeDefined();
    expect(ledger.files["docs/reference/meta.ts"]).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "BLUME_TRANSLATE_META_PARTIAL",
    ]);
  });

  it("fails the batch when the reply contains no usable titles", async () => {
    const root = await scratch();
    const item = metaItem(root, [metaOf(root, "guides", "Guides")]);
    const { run } = claudeRunner([{ result: "sorry, no JSON today" }]);

    const result = await runTranslate({
      agent: "claude",
      ledger: emptyLedger(),
      project: project(root),
      run,
      workList: workListOf([item]),
    });

    expect(result.counts).toEqual({ failed: 1, partial: 0, translated: 0 });
    expect(result.results[0]?.detail).toContain("no usable titles");
    expect(existsSync(join(root, "docs/fr/guides/meta.ts"))).toBe(false);
  });

  it("keys the root directory's title as '.' in the prompt", async () => {
    const root = await scratch();
    const item = metaItem(root, [metaOf(root, "", "Docs")]);
    const { calls, run } = claudeRunner([{ result: '{".": "Docs FR"}' }]);

    const result = await runTranslate({
      agent: "claude",
      ledger: emptyLedger(),
      project: project(root),
      run,
      workList: workListOf([item]),
    });

    expect(calls[0]?.options.prompt).toContain('".": "Docs"');
    expect(result.counts.translated).toBe(1);
    expect(existsSync(join(root, "docs/fr/meta.ts"))).toBe(true);
  });
});
