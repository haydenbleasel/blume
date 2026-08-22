import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import pLimit from "p-limit";
import pMap from "p-map";
import { join } from "pathe";

import { AGENTS } from "../audit/agent.ts";
import type { AgentKind } from "../audit/agent.ts";
import { writeTextAtomic } from "../core/fs-atomic.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { LocaleConfig } from "../core/schema.ts";
import type { Diagnostic } from "../core/types.ts";
import { readAgentOutput, runAgentHeadless } from "../eval/agents.ts";
import type { AgentOutput, HeadlessRunner } from "../eval/agents.ts";
import { DEFAULT_TRANSLATE_TIMEOUT_MS, translateAgentArgs } from "./agents.ts";
import { hashSource, stampLedger } from "./ledger.ts";
import type { TranslationLedger } from "./ledger.ts";
import { generateMetaModule } from "./meta.ts";
import { metaPrompt, pagePrompt } from "./prompts.ts";
import { parseMetaTitles, validateTranslation } from "./validate.ts";
import type {
  MetaWorkItem,
  PageWorkItem,
  TranslateWorkList,
  WorkItem,
} from "./work-list.ts";

export type TranslateItemStatus = "failed" | "partial" | "translated";

export interface TranslateItemResult {
  costUsd?: number;
  /** Why the item failed (agent error, validation failure, missing titles). */
  detail?: string;
  durationMs: number;
  item: WorkItem;
  status: TranslateItemStatus;
}

export type TranslateProgress =
  | {
      kind: "item-end";
      index: number;
      result: TranslateItemResult;
      total: number;
    }
  | { kind: "item-start"; index: number; item: WorkItem; total: number };

export interface TranslateRunOptions {
  agent: AgentKind;
  /** Parallel agent sessions. Defaults to 1 (serial). */
  concurrency?: number;
  /** Mutated in place: every validated write stamps its entry immediately. */
  ledger: TranslationLedger;
  onProgress?: (event: TranslateProgress) => void;
  /**
   * Called after each finished item to flush the ledger to disk, so an
   * interrupted run keeps everything already translated. Calls are serialized
   * here — concurrent workers finishing together never race the same file.
   * The flush's result (`writeLedger`'s wrote-or-not boolean) is ignored.
   */
  persistLedger?: () => Promise<boolean | undefined>;
  project: BlumeProject;
  /** The spawn function — injectable so tests never launch a real agent. */
  run?: HeadlessRunner;
  timeoutMs?: number;
  workList: TranslateWorkList;
}

export interface TranslateResult {
  agent: AgentKind;
  /** Total spend, when the agent CLI reports it (claude does, codex doesn't). */
  costUsd?: number;
  counts: Record<TranslateItemStatus, number>;
  diagnostics: Diagnostic[];
  durationMs: number;
  results: TranslateItemResult[];
}

interface RunContext {
  bin: string;
  dir: string;
  kind: AgentKind;
  run: HeadlessRunner;
  source: LocaleConfig;
  targets: Map<string, LocaleConfig>;
  timeoutMs: number;
}

/** The root directory's key in a meta-titles prompt (an empty key is opaque). */
const metaDirKey = (dir: string): string => (dir === "" ? "." : dir);

/**
 * One headless agent call. A missing executable rejects with ENOENT on every
 * platform (the runner spawns without a shell), which the command layer turns
 * into an install hint.
 */
const invokeAgent = async (
  context: RunContext,
  prompt: string,
  index: number
): Promise<AgentOutput> => {
  const messagePath = join(context.dir, `message-${index}.txt`);
  const result = await context.run(
    context.bin,
    translateAgentArgs(context.kind, messagePath),
    { cwd: context.dir, prompt, timeoutMs: context.timeoutMs }
  );
  return await readAgentOutput(context.kind, result, messagePath);
};

const runPageItem = async (
  item: PageWorkItem,
  index: number,
  context: RunContext,
  ledger: TranslationLedger
): Promise<TranslateItemResult> => {
  const started = performance.now();
  const done = (
    status: TranslateItemStatus,
    detail?: string,
    costUsd?: number
  ): TranslateItemResult => ({
    costUsd,
    detail,
    durationMs: Math.round(performance.now() - started),
    item,
    status,
  });

  const sourceText = await readFile(item.sourcePath, "utf-8");
  if (item.verbatim) {
    // A non-markdown include partial (code embed) has no prose to translate;
    // it's copied unchanged so the locale tree's relative includes resolve.
    await writeTextAtomic(item.targetPath, sourceText);
    stampLedger(ledger, item.sourceRel, item.locale, hashSource(sourceText));
    return done("translated");
  }
  // SAFETY: `targets` maps every configured locale, and work items only carry
  // configured locale codes.
  const target = context.targets.get(item.locale) as LocaleConfig;
  // A hand-authored translation can live at a non-canonical name (see
  // WorkStatus); the disk probe finds only canonical targets, and a miss just
  // means the prompt goes out without a style precedent.
  const previousTranslation = existsSync(item.targetPath)
    ? await readFile(item.targetPath, "utf-8")
    : undefined;
  const output = await invokeAgent(
    context,
    pagePrompt(sourceText, target, context.source, previousTranslation),
    index
  );
  if (output.isError) {
    return done("failed", output.detail ?? "agent failed", output.costUsd);
  }
  const validated = validateTranslation(sourceText, output.text);
  if (!validated.ok) {
    return done("failed", validated.reason, output.costUsd);
  }
  await writeTextAtomic(item.targetPath, validated.text);
  stampLedger(ledger, item.sourceRel, item.locale, hashSource(sourceText));
  return done("translated", undefined, output.costUsd);
};

const runMetaItem = async (
  item: MetaWorkItem,
  index: number,
  context: RunContext,
  ledger: TranslationLedger
): Promise<TranslateItemResult> => {
  const started = performance.now();
  const done = (
    status: TranslateItemStatus,
    detail?: string,
    costUsd?: number
  ): TranslateItemResult => ({
    costUsd,
    detail,
    durationMs: Math.round(performance.now() - started),
    item,
    status,
  });

  const titles = Object.fromEntries(
    item.entries.map((entry) => [metaDirKey(entry.meta.dir), entry.meta.title])
  );
  // SAFETY: `targets` maps every configured locale, and work items only carry
  // configured locale codes.
  const target = context.targets.get(item.locale) as LocaleConfig;
  const output = await invokeAgent(
    context,
    metaPrompt(titles, target, context.source),
    index
  );
  if (output.isError) {
    return done("failed", output.detail ?? "agent failed", output.costUsd);
  }

  const parsed = parseMetaTitles(output.text, Object.keys(titles));
  for (const entry of item.entries) {
    const translated = parsed.titles[metaDirKey(entry.meta.dir)];
    if (translated === undefined) {
      continue;
    }
    // Each entry writes and stamps independently, so a partially usable reply
    // still lands the titles it did translate.
    // oxlint-disable-next-line no-await-in-loop
    await writeTextAtomic(
      entry.targetPath,
      generateMetaModule(entry.meta.data, translated)
    );
    stampLedger(
      ledger,
      entry.meta.sourceRel,
      item.locale,
      hashSource(entry.meta.raw)
    );
  }

  if (parsed.missing.length === item.entries.length) {
    return done("failed", "reply contained no usable titles", output.costUsd);
  }
  if (parsed.missing.length > 0) {
    return done(
      "partial",
      `no translation for: ${parsed.missing.join(", ")}`,
      output.costUsd
    );
  }
  return done("translated", undefined, output.costUsd);
};

const itemDiagnostic = (result: TranslateItemResult): Diagnostic => {
  const { item } = result;
  const site =
    item.kind === "page"
      ? { file: item.sourcePath, subject: item.sourceRel }
      : {
          file: item.entries[0]?.meta.file,
          subject: `meta titles (${item.entries.length})`,
        };
  return {
    code:
      result.status === "partial"
        ? "BLUME_TRANSLATE_META_PARTIAL"
        : "BLUME_TRANSLATE_FAILED",
    file: site.file,
    message: `Translating ${site.subject} into "${item.locale}" ${
      result.status === "partial" ? "partially failed" : "failed"
    }: ${result.detail ?? "unknown error"}.`,
    severity: result.status === "partial" ? "warning" : "error",
  };
};

/**
 * Run every work item through the agent, `concurrency` at a time: each worker
 * is a serial lane pulling the next unclaimed item, so results stay indexed
 * by item and progress events interleave but never duplicate. A failed item
 * never writes or stamps; its lane continues. After every finished item the
 * ledger is flushed via `persistLedger` (serialized across lanes), so an
 * interrupted run resumes from what already landed instead of from scratch.
 */
export const runTranslate = async (
  options: TranslateRunOptions
): Promise<TranslateResult> => {
  const started = performance.now();
  const { i18n } = options.project.config;
  if (!i18n) {
    throw new Error("blume translate requires i18n to be configured");
  }
  // SAFETY: the config schema requires `defaultLocale` to be one of `locales`.
  const source = i18n.locales.find(
    (locale) => locale.code === i18n.defaultLocale
  ) as LocaleConfig;

  const context: RunContext = {
    bin: AGENTS[options.agent].bin,
    dir: await mkdtemp(join(tmpdir(), "blume-translate-")),
    kind: options.agent,
    run: options.run ?? runAgentHeadless,
    source,
    targets: new Map(i18n.locales.map((locale) => [locale.code, locale])),
    timeoutMs: options.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS,
  };

  const { items } = options.workList;
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 1, items.length || 1)
  );

  // The persist mutex: ledger flushes from concurrent lanes are serialized so
  // two lanes never write the ledger file at the same time.
  const persistLimit = pLimit(1);
  const persist = (): Promise<boolean | undefined> =>
    persistLimit(() => options.persistLedger?.());

  const results = await pMap(
    items,
    async (item: WorkItem, index): Promise<TranslateItemResult> => {
      options.onProgress?.({
        index,
        item,
        kind: "item-start",
        total: items.length,
      });
      const result = await (item.kind === "page"
        ? runPageItem(item, index, context, options.ledger)
        : runMetaItem(item, index, context, options.ledger));
      // Flush this item's stamps before the slot frees for the next item, so
      // a kill loses at most the in-flight items.
      await persist();
      options.onProgress?.({
        index,
        kind: "item-end",
        result,
        total: items.length,
      });
      return result;
    },
    { concurrency }
  );

  const diagnostics: Diagnostic[] = [];
  for (const result of results) {
    if (result.status !== "translated") {
      diagnostics.push(itemDiagnostic(result));
    }
  }

  const counts = {
    failed: 0,
    partial: 0,
    translated: 0,
  } satisfies Record<TranslateItemStatus, number>;
  for (const result of results) {
    counts[result.status] += 1;
  }
  const costs = results.flatMap((result) =>
    result.costUsd === undefined ? [] : [result.costUsd]
  );

  return {
    agent: options.agent,
    costUsd:
      costs.length > 0
        ? costs.reduce((total, cost) => total + cost, 0)
        : undefined,
    counts,
    diagnostics,
    durationMs: Math.round(performance.now() - started),
    results,
  };
};
