import { colors } from "consola/utils";
import type { ColorFunction } from "consola/utils";

import { AGENTS } from "../audit/agent.ts";
import type { AgentKind } from "../audit/agent.ts";
import { duration, money, seconds } from "../cli/report-format.ts";
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
 * The live progress UI, colored via consola's `colors` (which honors
 * NO_COLOR/FORCE_COLOR and TTY detection), matching the eval report's palette.
 * Render functions are pure; the renderer takes an injectable `write`/`now` so
 * tests never touch a real TTY or clock. The command sends everything here to
 * stderr via the raw `write` — never `logger.info`, which consola drops in
 * test and CI environments.
 */

const ESC = String.fromCodePoint(27);

const GLYPH = {
  failed: "✖",
  partial: "!",
  translated: "✔",
} satisfies Record<TranslateItemStatus, string>;

const STATUS_COLOR = {
  failed: colors.red,
  partial: colors.yellow,
  translated: colors.green,
} satisfies Record<TranslateItemStatus, ColorFunction>;

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

/** `docs/guides/install.mdx → fr`, or the batched meta call's label. */
export const itemLabel = (item: WorkItem): string =>
  item.kind === "page"
    ? `${item.sourceRel} → ${item.locale}`
    : `meta title${item.entries.length === 1 ? "" : "s"} (${item.entries.length}) → ${item.locale}`;

/**
 * The in-flight spinner line a TTY rewrites in place: the oldest active
 * item's label, how many more lanes are running, and the run's progress.
 */
export const spinnerLine = (
  active: WorkItem[],
  done: number,
  total: number,
  frame: number
): string => {
  // SAFETY: the renderer only paints while at least one item is active, so the
  // oldest active entry exists.
  const first = active[0] as WorkItem;
  const more = active.length > 1 ? ` (+${active.length - 1} more)` : "";
  // SAFETY: `frame % SPINNER_FRAMES.length` is always an index into the
  // non-empty frames array.
  return `  ${colors.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] as string)} ${itemLabel(first)}${more} ${colors.dim(`${done}/${total}`)}`;
};

/** The permanent line printed when an item finishes. */
export const itemEndLine = (result: TranslateItemResult): string => {
  const color = STATUS_COLOR[result.status];
  const glyph = color(GLYPH[result.status]);
  const label = itemLabel(result.item);
  if (result.status === "translated") {
    const cells = [seconds(result.durationMs), money(result.costUsd)]
      .filter((cell) => cell !== "")
      .join(" ");
    return `  ${glyph} ${label} ${colors.dim(cells)}`;
  }
  const word = result.status === "partial" ? "partial" : "failed";
  return `  ${glyph} ${label} ${color(word)}${
    result.detail ? colors.dim(`: ${result.detail}`) : ""
  }`;
};

/** The header line the command prints before the first item runs. */
export const translateHeaderLine = (
  itemCount: number,
  localeCount: number,
  agent: AgentKind
): string =>
  `${colors.bold("blume translate")}  ${itemCount} item(s) · ${localeCount} locale(s) · ${AGENTS[agent].name}`;

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
    (diagnostic) => `  ${colors.yellow("⚠")} ${colors.dim(diagnostic.message)}`
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
      `  ${colors.red("✖")} ${row.sourceRel} → ${row.locale} ${colors.dim(row.status)}`
  ),
  ...workList.untracked.map(
    (entry) =>
      `  ${colors.dim(`⊘ ${entry.sourceRel} → ${entry.locale} untracked (adopted by the next translate run)`)}`
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
const resultJson = (result: TranslateItemResult) => ({
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
      | {
          kind: "item-end";
          index: number;
          result: TranslateItemResult;
          total: number;
        }
      | { kind: "item-start"; index: number; item: WorkItem; total: number }
  ) => void;
  stop: () => void;
}

/**
 * Live progress: on a TTY the in-flight items render as one spinner line
 * rewritten in place (`\r\x1B[K`) — a concurrent run shows the oldest active
 * item plus a `(+n more)` count — and each completion prints its permanent
 * line above it; off-TTY (CI) there is no interval and only the permanent
 * per-item lines print.
 */
export const createProgressRenderer = (options: {
  isTTY: boolean;
  write: (chunk: string) => void;
  now?: () => number;
}): ProgressRenderer => {
  const now = options.now ?? (() => performance.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  const active = new Map<number, WorkItem>();
  let done = 0;
  let total = 0;
  let startedAt = 0;

  const paint = (): void => {
    if (active.size > 0) {
      const frame = Math.floor((now() - startedAt) / SPINNER_INTERVAL_MS);
      options.write(
        `${REWRITE}${spinnerLine([...active.values()], done, total, frame)}`
      );
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
      ({ total } = event);
      if (event.kind === "item-start") {
        active.set(event.index, event.item);
        if (!options.isTTY) {
          return;
        }
        if (!timer) {
          startedAt = now();
          timer = setInterval(paint, SPINNER_INTERVAL_MS);
          timer.unref?.();
        }
        paint();
        return;
      }
      active.delete(event.index);
      done += 1;
      const line = itemEndLine(event.result);
      if (!options.isTTY) {
        options.write(`${line}\n`);
        return;
      }
      options.write(`${REWRITE}${line}\n`);
      if (active.size > 0) {
        paint();
      } else {
        clearTimer();
      }
    },
    stop() {
      clearTimer();
      active.clear();
    },
  };
};
