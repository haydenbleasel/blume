import { AGENTS } from "../audit/agent.ts";
import type { AgentKind } from "../audit/agent.ts";
import { countBySeverity } from "../core/diagnostics.ts";
import type { Diagnostic } from "../core/types.ts";
import type {
  TranslateItemResult,
  TranslateItemStatus,
  TranslateResult,
} from "./run.ts";
import type {
  MetaWorkEntry,
  TranslateWorkList,
  WorkItem,
  WorkStatus,
} from "./work-list.ts";

/**
 * The live progress UI, hand-rolled ANSI (no new dependencies), matching the
 * eval report's palette. Render functions are pure; the renderer takes an
 * injectable `write`/`now` so tests never touch a real TTY or clock. The
 * command sends everything here to stderr via the raw `write` — never
 * `logger.info`, which consola drops in test and CI environments.
 */

const ESC = String.fromCodePoint(27);
const COLORS = {
  bold: `${ESC}[1m`,
  cyan: `${ESC}[36m`,
  dim: `${ESC}[2m`,
  green: `${ESC}[32m`,
  red: `${ESC}[31m`,
  reset: `${ESC}[0m`,
  yellow: `${ESC}[33m`,
};

const GLYPH: Record<TranslateItemStatus, string> = {
  failed: "✖",
  partial: "!",
  translated: "✔",
};

const STATUS_COLOR: Record<TranslateItemStatus, string> = {
  failed: COLORS.red,
  partial: COLORS.yellow,
  translated: COLORS.green,
};

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** How often the TTY spinner advances (one frame per interval). */
export const SPINNER_INTERVAL_MS = 80;

/** The clear-to-start-of-line prefix every TTY rewrite uses. */
const REWRITE = `\r${ESC}[K`;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const money = (cost: number | undefined): string =>
  cost === undefined ? "" : `$${cost.toFixed(2)}`;

const duration = (ms: number): string => {
  if (ms < 60_000) {
    return seconds(ms);
  }
  const minutes = Math.floor(ms / 60_000);
  const rest = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${rest}s`;
};

/** `docs/guides/install.mdx → fr`, or the batched meta call's label. */
export const itemLabel = (item: WorkItem): string =>
  item.kind === "page"
    ? `${item.sourceRel} → ${item.locale}`
    : `meta title${item.entries.length === 1 ? "" : "s"} (${item.entries.length}) → ${item.locale}`;

/** The in-flight spinner line a TTY rewrites in place. */
export const activeLine = (item: WorkItem, frame: number): string =>
  `  ${COLORS.cyan}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${COLORS.reset} ${itemLabel(item)}`;

/** The permanent line printed when an item finishes. */
export const itemEndLine = (result: TranslateItemResult): string => {
  const color = STATUS_COLOR[result.status];
  const glyph = `${color}${GLYPH[result.status]}${COLORS.reset}`;
  const label = itemLabel(result.item);
  if (result.status === "translated") {
    const cells = [seconds(result.durationMs), money(result.costUsd)]
      .filter((cell) => cell !== "")
      .join(" ");
    return `  ${glyph} ${label} ${COLORS.dim}${cells}${COLORS.reset}`;
  }
  const word = result.status === "partial" ? "partial" : "failed";
  return `  ${glyph} ${label} ${color}${word}${COLORS.reset}${
    result.detail ? `${COLORS.dim}: ${result.detail}${COLORS.reset}` : ""
  }`;
};

/** The header line the command prints before the first item runs. */
export const translateHeaderLine = (
  itemCount: number,
  localeCount: number,
  agent: AgentKind
): string =>
  `${COLORS.bold}blume translate${COLORS.reset}  ${itemCount} item(s) · ${localeCount} locale(s) · ${AGENTS[agent].name}`;

/**
 * `Translated 11 files into 2 locales · 1 failed · 2 adopted · 8 already up to
 * date · 4m 12s · $0.41` (cost only when the agent reports one).
 */
export const translateSummaryLine = (
  result: TranslateResult,
  workList: TranslateWorkList
): string => {
  const { counts } = result;
  const parts = [
    `Translated ${counts.translated} file${counts.translated === 1 ? "" : "s"} into ${workList.targetLocales.length} locale${workList.targetLocales.length === 1 ? "" : "s"}`,
    counts.failed > 0 ? `${counts.failed} failed` : "",
    counts.partial > 0 ? `${counts.partial} partial` : "",
    workList.untracked.length > 0 ? `${workList.untracked.length} adopted` : "",
    workList.upToDate > 0 ? `${workList.upToDate} already up to date` : "",
    duration(result.durationMs),
    money(result.costUsd),
  ].filter((part) => part !== "");
  return parts.join(" · ");
};

/** Dim warnings for work-list diagnostics (e.g. a factory-form meta file). */
export const diagnosticLines = (diagnostics: Diagnostic[]): string[] =>
  diagnostics.map(
    (diagnostic) =>
      `  ${COLORS.yellow}⚠${COLORS.reset} ${COLORS.dim}${diagnostic.message}${COLORS.reset}`
  );

/** Every (source, locale, status) drift row in a work list, pages then meta. */
const driftRows = (
  workList: TranslateWorkList
): { locale: string; sourceRel: string; status: WorkStatus }[] =>
  workList.items.flatMap((item) =>
    item.kind === "page"
      ? [
          {
            locale: item.locale,
            sourceRel: item.sourceRel,
            status: item.status,
          },
        ]
      : item.entries.map((entry: MetaWorkEntry) => ({
          locale: item.locale,
          sourceRel: entry.meta.sourceRel,
          status: entry.status,
        }))
  );

/** One line per missing/stale pair, plus dim lines for untracked adoptions. */
export const checkLines = (workList: TranslateWorkList): string[] => [
  ...driftRows(workList).map(
    (row) =>
      `  ${COLORS.red}✖${COLORS.reset} ${row.sourceRel} → ${row.locale} ${COLORS.dim}${row.status}${COLORS.reset}`
  ),
  ...workList.untracked.map(
    (entry) =>
      `  ${COLORS.dim}⊘ ${entry.sourceRel} → ${entry.locale} untracked (adopted by the next translate run)${COLORS.reset}`
  ),
];

/** The `--check` totals: `2 missing · 1 stale · 1 untracked · 14 up to date`. */
export const checkSummaryLine = (workList: TranslateWorkList): string => {
  const rows = driftRows(workList);
  const missing = rows.filter((row) => row.status === "missing").length;
  const stale = rows.filter((row) => row.status === "stale").length;
  const parts = [
    missing > 0 ? `${missing} missing` : "",
    stale > 0 ? `${stale} stale` : "",
    workList.untracked.length > 0
      ? `${workList.untracked.length} untracked`
      : "",
    `${workList.upToDate} up to date`,
  ].filter((part) => part !== "");
  return parts.join(" · ");
};

/** Whether a work list fails the `--check` gate (untracked never does). */
export const hasDrift = (workList: TranslateWorkList): boolean =>
  workList.items.length > 0;

/**
 * The machine-readable `--check` report. The `diagnostics` + `summary` shape
 * matches `blume validate/audit/eval --json` exactly, with the drift report
 * under `translate`.
 */
export const checkReportJson = (workList: TranslateWorkList): string => {
  const locales: Record<
    string,
    { missing: string[]; stale: string[]; untracked: string[] }
  > = {};
  for (const locale of workList.targetLocales) {
    locales[locale] = { missing: [], stale: [], untracked: [] };
  }
  for (const row of driftRows(workList)) {
    locales[row.locale]?.[row.status].push(row.sourceRel);
  }
  for (const entry of workList.untracked) {
    locales[entry.locale]?.untracked.push(entry.sourceRel);
  }
  return `${JSON.stringify(
    {
      diagnostics: workList.diagnostics,
      summary: countBySeverity(workList.diagnostics),
      translate: { locales, upToDate: workList.upToDate },
    },
    null,
    2
  )}\n`;
};

/** One run result lowered to JSON-friendly, root-relative fields. */
const resultJson = (result: TranslateItemResult): Record<string, unknown> => ({
  costUsd: result.costUsd,
  detail: result.detail,
  durationMs: result.durationMs,
  kind: result.item.kind,
  locale: result.item.locale,
  status: result.status,
  ...(result.item.kind === "page"
    ? { source: result.item.sourceRel, target: result.item.targetRel }
    : {
        sources: result.item.entries.map((entry) => entry.meta.sourceRel),
      }),
});

/** The machine-readable report for a translation run (`--json`). */
export const translateReportJson = (
  result: TranslateResult,
  workList: TranslateWorkList
): string => {
  const diagnostics = [...workList.diagnostics, ...result.diagnostics];
  return `${JSON.stringify(
    {
      diagnostics,
      summary: countBySeverity(diagnostics),
      translate: {
        adopted: workList.untracked.length,
        agent: result.agent,
        costUsd: result.costUsd,
        counts: result.counts,
        durationMs: result.durationMs,
        results: result.results.map(resultJson),
        upToDate: workList.upToDate,
      },
    },
    null,
    2
  )}\n`;
};

export interface ProgressRenderer {
  onProgress: (
    event:
      | { kind: "item-end"; result: TranslateItemResult }
      | { kind: "item-start"; item: WorkItem }
  ) => void;
  stop: () => void;
}

/**
 * Live progress: on a TTY the active item renders as a spinner line rewritten
 * in place (`\r\x1B[K`), replaced by its permanent line on completion; off-TTY
 * (CI) there is no interval and only the permanent per-item lines print.
 */
export const createProgressRenderer = (options: {
  isTTY: boolean;
  write: (chunk: string) => void;
  now?: () => number;
}): ProgressRenderer => {
  const now = options.now ?? (() => performance.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: WorkItem | undefined;
  let startedAt = 0;

  const paint = (): void => {
    if (active) {
      const frame = Math.floor((now() - startedAt) / SPINNER_INTERVAL_MS);
      options.write(`${REWRITE}${activeLine(active, frame)}`);
    }
  };
  const clearTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    onProgress(event) {
      if (event.kind === "item-start") {
        if (!options.isTTY) {
          return;
        }
        active = event.item;
        startedAt = now();
        paint();
        timer = setInterval(paint, SPINNER_INTERVAL_MS);
        timer.unref?.();
        return;
      }
      clearTimer();
      active = undefined;
      const line = itemEndLine(event.result);
      options.write(options.isTTY ? `${REWRITE}${line}\n` : `${line}\n`);
    },
    stop() {
      clearTimer();
      active = undefined;
    },
  };
};
