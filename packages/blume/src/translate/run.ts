import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { AGENTS, WINDOWS_COMMAND_NOT_FOUND } from "../audit/agent.ts";
import type { AgentKind } from "../audit/agent.ts";
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
   */
  persistLedger?: () => Promise<unknown>;
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

/** Write atomically (temp + rename) so a watcher never sees a partial file. */
const writeFileAtomic = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf-8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
};

/**
 * One headless agent call. A Windows shell launch reports a missing executable
 * through exit code 9009 instead of a spawn error, so that is normalized to
 * the ENOENT rejection the command layer already turns into an install hint.
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
  if (!result.timedOut && result.code === WINDOWS_COMMAND_NOT_FOUND) {
    const missing = new Error(
      `${context.bin} was not found on PATH`
    ) as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    throw missing;
  }
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
  const target = context.targets.get(item.locale) as LocaleConfig;
  const output = await invokeAgent(
    context,
    pagePrompt(sourceText, target, context.source),
    index
  );
  if (output.isError) {
    return done("failed", output.detail ?? "agent failed", output.costUsd);
  }
  const validated = validateTranslation(sourceText, output.text);
  if (!validated.ok) {
    return done("failed", validated.reason, output.costUsd);
  }
  await writeFileAtomic(item.targetPath, validated.text);
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
    await writeFileAtomic(
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
  const results: TranslateItemResult[] = Array.from({ length: items.length });
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 1, items.length || 1)
  );

  // The persist chain: whichever lane finishes next appends its flush after
  // the previous one, so two lanes never write the ledger file concurrently.
  let persisting: Promise<unknown> = Promise.resolve();
  const persist = (): Promise<unknown> => {
    // The chain is the mutex: appending with .then() serializes flushes.
    // oxlint-disable-next-line promise/prefer-await-to-then
    persisting = persisting.then(() => options.persistLedger?.());
    return persisting;
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index] as WorkItem;
      options.onProgress?.({
        index,
        item,
        kind: "item-start",
        total: items.length,
      });
      // oxlint-disable-next-line no-await-in-loop -- each worker is a serial lane
      const result = await (item.kind === "page"
        ? runPageItem(item, index, context, options.ledger)
        : runMetaItem(item, index, context, options.ledger));
      results[index] = result;
      // Flush this item's stamps before claiming the next one, so a kill
      // loses at most the in-flight items.
      // oxlint-disable-next-line no-await-in-loop
      await persist();
      options.onProgress?.({
        index,
        kind: "item-end",
        result,
        total: items.length,
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const diagnostics: Diagnostic[] = [];
  for (const result of results) {
    if (result.status !== "translated") {
      diagnostics.push(itemDiagnostic(result));
    }
  }

  const counts: Record<TranslateItemStatus, number> = {
    failed: 0,
    partial: 0,
    translated: 0,
  };
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
