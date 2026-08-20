import { describe, expect, it } from "bun:test";

import type { TranslatableMeta } from "../src/translate/meta.ts";
import {
  checkLines,
  checkReportJson,
  checkSummaryLine,
  createProgressRenderer,
  diagnosticLines,
  hasDrift,
  itemEndLine,
  itemLabel,
  SPINNER_FRAMES,
  spinnerLine,
  translateHeaderLine,
  translateReportJson,
  translateSummaryLine,
} from "../src/translate/report.ts";
import type {
  TranslateItemResult,
  TranslateResult,
} from "../src/translate/run.ts";
import type {
  MetaWorkItem,
  PageWorkItem,
  TranslateWorkList,
} from "../src/translate/work-list.ts";

const strip = (text: string): string =>
  // oxlint-disable-next-line no-control-regex
  text.replaceAll(/\[\d+m/gu, "");

const page = (over: Partial<PageWorkItem> = {}): PageWorkItem => ({
  kind: "page",
  locale: "fr",
  sourcePath: "/repo/docs/guides/install.mdx",
  sourceRel: "docs/guides/install.mdx",
  status: "missing",
  targetPath: "/repo/docs/fr/guides/install.mdx",
  targetRel: "docs/fr/guides/install.mdx",
  ...over,
});

const metaSource = (dir: string): TranslatableMeta => ({
  contentRoot: "/repo/docs",
  data: { title: "Guides" },
  dir,
  file: `/repo/docs/${dir}/meta.ts`,
  raw: "raw",
  sourceRel: `docs/${dir}/meta.ts`,
  title: "Guides",
});

const meta = (dirsIn: string[], locale = "fr"): MetaWorkItem => ({
  entries: dirsIn.map((dir) => ({
    meta: metaSource(dir),
    status: "missing" as const,
    targetPath: `/repo/docs/${locale}/${dir}/meta.ts`,
  })),
  kind: "meta",
  locale,
});

const workListOf = (
  over: Partial<TranslateWorkList> = {}
): TranslateWorkList => ({
  diagnostics: [],
  items: [],
  knownSources: new Set(),
  targetLocales: ["fr"],
  untracked: [],
  upToDate: 0,
  ...over,
});

const resultOf = (
  item: MetaWorkItem | PageWorkItem,
  over: Partial<TranslateItemResult> = {}
): TranslateItemResult => ({
  durationMs: 4200,
  item,
  status: "translated",
  ...over,
});

const runOf = (over: Partial<TranslateResult> = {}): TranslateResult => ({
  agent: "claude",
  counts: { failed: 0, partial: 0, translated: 1 },
  diagnostics: [],
  durationMs: 252_000,
  results: [resultOf(page())],
  ...over,
});

describe("labels and lines", () => {
  it("labels page and meta items", () => {
    expect(itemLabel(page())).toBe("docs/guides/install.mdx → fr");
    expect(itemLabel(meta(["guides"]))).toBe("meta title (1) → fr");
    expect(itemLabel(meta(["guides", "reference"]))).toBe(
      "meta titles (2) → fr"
    );
  });

  it("cycles spinner frames and counts extra in-flight lanes", () => {
    expect(strip(spinnerLine([page()], 0, 3, 0))).toBe(
      `  ${SPINNER_FRAMES[0]} docs/guides/install.mdx → fr 0/3`
    );
    expect(
      strip(
        spinnerLine(
          [page(), page({ locale: "de" }), meta(["guides"])],
          5,
          132,
          SPINNER_FRAMES.length + 2
        )
      )
    ).toBe(
      `  ${SPINNER_FRAMES[2]} docs/guides/install.mdx → fr (+2 more) 5/132`
    );
  });

  it("renders permanent end lines per status", () => {
    expect(strip(itemEndLine(resultOf(page(), { costUsd: 0.03 })))).toBe(
      "  ✔ docs/guides/install.mdx → fr 4.2s $0.03"
    );
    expect(strip(itemEndLine(resultOf(page())))).toBe(
      "  ✔ docs/guides/install.mdx → fr 4.2s"
    );
    expect(
      strip(
        itemEndLine(resultOf(page(), { detail: "timed out", status: "failed" }))
      )
    ).toBe("  ✖ docs/guides/install.mdx → fr failed: timed out");
    expect(strip(itemEndLine(resultOf(page(), { status: "failed" })))).toBe(
      "  ✖ docs/guides/install.mdx → fr failed"
    );
    expect(
      strip(
        itemEndLine(
          resultOf(meta(["guides", "reference"]), {
            detail: "no translation for: reference",
            status: "partial",
          })
        )
      )
    ).toBe("  ! meta titles (2) → fr partial: no translation for: reference");
  });

  it("renders the header and diagnostics", () => {
    expect(strip(translateHeaderLine(3, 2, "claude"))).toBe(
      "blume translate  3 item(s) · 2 locale(s) · Claude Code"
    );
    expect(
      diagnosticLines([
        {
          code: "BLUME_TRANSLATE_META_FACTORY",
          message: "factory meta",
          severity: "warning",
        },
      ]).map(strip)
    ).toEqual(["  ⚠ factory meta"]);
  });
});

describe("summaries", () => {
  it("builds the full run summary with every segment", () => {
    const summary = translateSummaryLine(
      runOf({
        costUsd: 0.41,
        counts: { failed: 1, partial: 1, translated: 11 },
      }),
      workListOf({
        targetLocales: ["de", "fr"],
        untracked: [
          { hash: "h", kind: "page", locale: "fr", sourceRel: "docs/x.mdx" },
        ],
        upToDate: 8,
      })
    );
    expect(summary).toBe(
      "Translated 11 files into 2 locales · 1 failed · 1 partial · 1 adopted · 8 already up to date · 4m 12s · $0.41"
    );
  });

  it("drops empty segments and uses singular forms", () => {
    const summary = translateSummaryLine(
      runOf({ durationMs: 5100 }),
      workListOf()
    );
    expect(summary).toBe("Translated 1 file into 1 locale · 5.1s");
  });

  it("summarizes a check run", () => {
    const workList = workListOf({
      items: [
        page(),
        page({ locale: "de", status: "stale" }),
        meta(["guides"], "de"),
      ],
      targetLocales: ["de", "fr"],
      untracked: [
        { hash: "h", kind: "page", locale: "fr", sourceRel: "docs/x.mdx" },
      ],
      upToDate: 14,
    });
    expect(checkSummaryLine(workList)).toBe(
      "2 missing · 1 stale · 1 untracked · 14 up to date"
    );
    expect(checkSummaryLine(workListOf({ upToDate: 3 }))).toBe("3 up to date");
  });
});

describe("check reporting", () => {
  const workList = workListOf({
    items: [
      page(),
      page({ locale: "de", sourceRel: "docs/index.mdx", status: "stale" }),
      meta(["guides"], "de"),
    ],
    targetLocales: ["de", "fr"],
    untracked: [
      { hash: "h", kind: "meta", locale: "fr", sourceRel: "docs/g/meta.ts" },
    ],
    upToDate: 14,
  });

  it("prints one row per drifted pair plus dim untracked rows", () => {
    expect(checkLines(workList).map(strip)).toEqual([
      "  ✖ docs/guides/install.mdx → fr missing",
      "  ✖ docs/index.mdx → de stale",
      "  ✖ docs/guides/meta.ts → de missing",
      "  ⊘ docs/g/meta.ts → fr untracked (adopted by the next translate run)",
    ]);
  });

  it("gates on missing/stale only", () => {
    expect(hasDrift(workList)).toBe(true);
    expect(
      hasDrift(workListOf({ untracked: workList.untracked, upToDate: 2 }))
    ).toBe(false);
  });

  it("emits the shared diagnostics + summary JSON shape, grouped by locale", () => {
    const parsed = JSON.parse(checkReportJson(workList));
    expect(parsed.translate).toEqual({
      locales: {
        de: {
          missing: ["docs/guides/meta.ts"],
          stale: ["docs/index.mdx"],
          untracked: [],
        },
        fr: {
          missing: ["docs/guides/install.mdx"],
          stale: [],
          untracked: ["docs/g/meta.ts"],
        },
      },
      upToDate: 14,
    });
    expect(parsed.summary).toEqual({ error: 0, info: 0, warning: 0 });
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("translateReportJson", () => {
  it("lowers results to root-relative fields and merges diagnostics", () => {
    const json = JSON.parse(
      translateReportJson(
        runOf({
          costUsd: 0.1,
          diagnostics: [
            {
              code: "BLUME_TRANSLATE_FAILED",
              message: "failed",
              severity: "error",
            },
          ],
          results: [
            resultOf(page(), { costUsd: 0.1 }),
            resultOf(meta(["guides"]), { detail: "x", status: "partial" }),
          ],
        }),
        workListOf({
          diagnostics: [
            {
              code: "BLUME_TRANSLATE_META_FACTORY",
              message: "factory",
              severity: "warning",
            },
          ],
          untracked: [
            { hash: "h", kind: "page", locale: "fr", sourceRel: "docs/x.mdx" },
          ],
          upToDate: 2,
        })
      )
    );
    expect(json.translate.agent).toBe("claude");
    expect(json.translate.adopted).toBe(1);
    expect(json.translate.upToDate).toBe(2);
    expect(json.translate.results[0]).toMatchObject({
      kind: "page",
      locale: "fr",
      source: "docs/guides/install.mdx",
      status: "translated",
      target: "docs/fr/guides/install.mdx",
    });
    expect(json.translate.results[1]).toMatchObject({
      kind: "meta",
      sources: ["docs/guides/meta.ts"],
      status: "partial",
    });
    expect(json.summary).toEqual({ error: 1, info: 0, warning: 1 });
    expect(json.diagnostics).toHaveLength(2);
  });
});

describe("createProgressRenderer", () => {
  it("rewrites the active line in place on a TTY and prints the end line", () => {
    const writes: string[] = [];
    let time = 0;
    const renderer = createProgressRenderer({
      isTTY: true,
      now: () => time,
      write: (chunk) => writes.push(chunk),
    });

    renderer.onProgress({
      index: 0,
      item: page(),
      kind: "item-start",
      total: 1,
    });
    expect(writes[0]).toStartWith("\r[K");
    // SAFETY: the item-start above painted the spinner, so writes[0] exists.
    expect(strip(writes[0] as string)).toContain(
      `${SPINNER_FRAMES[0]} docs/guides/install.mdx → fr`
    );

    time = 250;
    renderer.onProgress({
      index: 0,
      kind: "item-end",
      result: resultOf(page(), { costUsd: 0.03 }),
      total: 1,
    });
    // SAFETY: the item-end above wrote the permanent line, so a last write
    // exists.
    const last = writes.at(-1) as string;
    expect(last).toStartWith("\r[K");
    expect(last).toEndWith("\n");
    expect(strip(last)).toContain("✔ docs/guides/install.mdx → fr");
    renderer.stop();
  });

  it("keeps painting the surviving lanes of a concurrent run", () => {
    const writes: string[] = [];
    const renderer = createProgressRenderer({
      isTTY: true,
      now: () => 0,
      write: (chunk) => writes.push(chunk),
    });
    renderer.onProgress({
      index: 0,
      item: page(),
      kind: "item-start",
      total: 3,
    });
    renderer.onProgress({
      index: 1,
      item: page({ locale: "de" }),
      kind: "item-start",
      total: 3,
    });
    // SAFETY: both item-starts above painted the spinner, so a last write
    // exists.
    expect(strip(writes.at(-1) as string)).toContain("(+1 more) 0/3");

    // The first lane finishes: its permanent line prints, then the spinner
    // repaints with the remaining lane and the bumped done count.
    renderer.onProgress({
      index: 0,
      kind: "item-end",
      result: resultOf(page()),
      total: 3,
    });
    // SAFETY: the item-end above wrote the permanent line and then repainted
    // the surviving lane, so the last two writes exist.
    expect(strip(writes.at(-2) as string)).toContain("✔");
    // SAFETY: see above — the repaint is the last write.
    const repaint = strip(writes.at(-1) as string);
    expect(repaint).toContain("docs/guides/install.mdx → de 1/3");
    expect(repaint).not.toContain("more");
    renderer.stop();
  });

  it("prints only permanent end lines off-TTY", () => {
    const writes: string[] = [];
    const renderer = createProgressRenderer({
      isTTY: false,
      write: (chunk) => writes.push(chunk),
    });
    renderer.onProgress({
      index: 0,
      item: page(),
      kind: "item-start",
      total: 1,
    });
    expect(writes).toEqual([]);
    renderer.onProgress({
      index: 0,
      kind: "item-end",
      result: resultOf(page()),
      total: 1,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("\r");
    // SAFETY: toHaveLength(1) above proved writes[0] exists.
    expect(strip(writes[0] as string)).toBe(
      "  ✔ docs/guides/install.mdx → fr 4.2s\n"
    );
    renderer.stop();
  });

  it("runs on the real clock when no `now` is injected", () => {
    const writes: string[] = [];
    const renderer = createProgressRenderer({
      isTTY: true,
      write: (chunk) => writes.push(chunk),
    });
    renderer.onProgress({
      index: 0,
      item: page(),
      kind: "item-start",
      total: 1,
    });
    renderer.onProgress({
      index: 0,
      kind: "item-end",
      result: resultOf(page()),
      total: 1,
    });
    expect(writes.length).toBeGreaterThanOrEqual(2);
    renderer.stop();
  });

  it("stops a live spinner cleanly", () => {
    const writes: string[] = [];
    const renderer = createProgressRenderer({
      isTTY: true,
      now: () => 0,
      write: (chunk) => writes.push(chunk),
    });
    renderer.onProgress({
      index: 0,
      item: page(),
      kind: "item-start",
      total: 1,
    });
    renderer.stop();
    const count = writes.length;
    // A stopped renderer paints nothing further.
    renderer.stop();
    expect(writes.length).toBe(count);
  });
});
