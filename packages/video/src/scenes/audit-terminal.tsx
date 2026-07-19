"use client";

import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// The two audit terminal scenes, sharing one frosted-card renderer:
//   AuditReport — `blume audit` dumps a findings report (grouped by check,
//   exactly the shape the real CLI prints).
//   AuditAgent — `blume audit --codex` hands the findings to Codex (the
//   startup banner and the echoed fix prompt, mirroring the docs CLI page's
//   Audit spotlight), then a rerun comes back green.

const SANS =
  "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif";
const MONO = "var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace";

const INK = "rgba(0,0,0,0.85)";
const MUTED = "rgba(0,0,0,0.55)";
const FAINT = "rgba(0,0,0,0.34)";
const ACCENT = "#009696";
const ERROR = "#d64545";
const WARNING = "#b45309";
const GREEN = "#1a9950";
const CHROME_BORDER = "rgba(90,100,120,0.14)";

const CARD_W = 960;
const CARD_H = 564;
const CHROME_H = 40;
const PAD_X = 26;
const PAD_TOP = 12;
const PAD_BOTTOM = 18;
const LINE_H = 23;
const VIEW_H = CARD_H - CHROME_H - PAD_TOP - PAD_BOTTOM;
// Real report columns: url.padEnd(34) before the dim source file.
const URL_COL_W = 296;
// Block heights for the Codex session pieces — fixed so the scroll math and
// the layout agree exactly (the wrappers are sized to these).
const BANNER_H = 104;
const PROMPT_H = 340;

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const CHARS_PER_FRAME = 2;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

type Severity = "error" | "warning";

interface TermLine {
  kind:
    | "cmd"
    | "blank"
    | "header"
    | "summary"
    | "category"
    | "finding"
    | "page"
    | "more"
    | "fix"
    | "hand"
    | "banner"
    | "prompt"
    | "ok";
  text?: string;
  /** header: the dim `pages · dir` tail; finding: the dim page count. */
  meta?: string;
  /** page lines: the dim source file that fixes the page. */
  file?: string;
  severity?: Severity;
  /** Frames after the previous line finishes before this one lands. */
  delay: number;
  /** Extra hold after this line, before the next starts. */
  pause?: number;
}

// The Codex session it opens — the startup banner and the echoed agent prompt,
// copy lifted from the docs CLI page (which mirrors `fixPrompt` in
// packages/blume/src/audit/agent.ts).
const CODEX_BANNER = {
  rows: [
    { label: "model:     ", value: "gpt-5.6-sol xhigh" },
    { label: "directory: ", value: "~/acme" },
  ],
  title: ">_ OpenAI Codex (v0.144.3)",
};

const CODEX_PROMPT: string[][] = [
  ["Fix the issues found by `blume audit` in this project."],
  [
    "The full audit report is at report.json. It is JSON: each entry in `diagnostics` is one finding, with the check `code`, a `message` explaining what is wrong, the affected page `url`, the source `file` to edit (relative to the current directory, with a `line` when the finding points at a specific front matter key), and a `suggestion` describing the fix.",
  ],
  [
    "Work through every finding:",
    "1. Read the report and group the findings by `file`.",
    "2. Apply each finding's `suggestion` by editing the named source file — most fixes are front matter edits at the cited line.",
    "3. Never fix a finding by deleting a page, removing content, or hiding it from the audit; if a finding genuinely needs a human decision, leave it and say so in your summary.",
  ],
  [
    "When you are done, run `blume build` and then `blume audit` to verify, and repeat until the audit reports no issues.",
  ],
];

const REPORT_HEADER_META = "124 pages · dist · offline";
const REPORT_SUMMARY = "10,788 audits · 2 errors · 3 warnings · 0 notes";

// Scene 1's script. Copy mirrors `formatReport` in
// packages/blume/src/audit/report.ts — real check titles, real fix strings,
// counts that add up (2 errors + 3 warnings = 5 findings handed off later).
const REPORT_LINES: TermLine[] = [
  { delay: 16, kind: "cmd", text: "blume audit" },
  { delay: 10, kind: "blank" },
  { delay: 0, kind: "header", meta: REPORT_HEADER_META },
  { delay: 3, kind: "summary", text: REPORT_SUMMARY },
  { delay: 3, kind: "blank" },
  { delay: 2, kind: "category", text: "content" },
  {
    delay: 3,
    kind: "finding",
    meta: "1 page",
    severity: "error",
    text: "Title tag missing or empty",
  },
  {
    delay: 2,
    file: "docs/guides/webhooks.mdx",
    kind: "page",
    text: "/guides/webhooks",
  },
  {
    delay: 2,
    kind: "fix",
    text: "fix: Add a `title` to the page's frontmatter.",
  },
  {
    delay: 4,
    kind: "finding",
    meta: "3 pages",
    severity: "warning",
    text: "Meta description missing or empty",
  },
  { delay: 2, file: "docs/api/errors.mdx", kind: "page", text: "/api/errors" },
  {
    delay: 2,
    file: "docs/guides/rate-limits.mdx",
    kind: "page",
    text: "/guides/rate-limits",
  },
  { delay: 2, kind: "more", text: "… and 1 more (--verbose)" },
  {
    delay: 2,
    kind: "fix",
    text: "fix: Add a `description` to the page's frontmatter.",
  },
  { delay: 4, kind: "blank" },
  { delay: 0, kind: "category", text: "links" },
  {
    delay: 3,
    kind: "finding",
    meta: "1 page",
    severity: "error",
    text: "Page has links to a broken page",
  },
  {
    delay: 2,
    file: "docs/quickstart.mdx:41",
    kind: "page",
    text: "/quickstart",
  },
  {
    delay: 2,
    kind: "fix",
    text: "fix: Fix the link target, or create the page it points at.",
  },
];

// Scene 2's script: the handoff — header + summary again for continuity (the
// real `--codex` run re-prints the report before handing off), the Codex
// session, then the clean rerun.
const AGENT_LINES: TermLine[] = [
  { delay: 16, kind: "cmd", text: "blume audit --codex" },
  { delay: 10, kind: "blank" },
  { delay: 0, kind: "header", meta: REPORT_HEADER_META },
  { delay: 3, kind: "summary", text: REPORT_SUMMARY },
  { delay: 3, kind: "blank" },
  { delay: 4, kind: "hand", text: "Handing 5 findings to Codex…" },
  { delay: 8, kind: "banner", pause: 10 },
  // The Codex session holds on screen — the beat where the agent works.
  { delay: 6, kind: "prompt", pause: 85 },
  { delay: 10, kind: "blank" },
  { delay: 0, kind: "cmd", text: "blume audit" },
  { delay: 10, kind: "blank" },
  { delay: 0, kind: "header", meta: REPORT_HEADER_META },
  {
    delay: 3,
    kind: "summary",
    text: "10,788 audits · 0 errors · 0 warnings · 0 notes",
  },
  { delay: 3, kind: "blank" },
  { delay: 2, kind: "ok", text: "✔ No issues found." },
];

/** Frames a line spends arriving: cmd lines type, output lines just land. */
const arrival = (line: TermLine): number =>
  line.kind === "cmd"
    ? Math.ceil((line.text?.length ?? 0) / CHARS_PER_FRAME)
    : 0;

const heightOf = (line: TermLine): number => {
  if (line.kind === "banner") {
    return BANNER_H;
  }
  if (line.kind === "prompt") {
    return PROMPT_H;
  }
  return LINE_H;
};

interface TermScript {
  duration: number;
  lines: TermLine[];
  scrollSteps: { start: number; delta: number }[];
  starts: number[];
}

// Compile a script: absolute start frames, total duration, and the terminal
// scroll — once the content outgrows the viewport, each new line eases the
// buffer up just far enough to stay visible (monotonic by construction).
const makeScript = (lines: TermLine[], tailHold: number): TermScript => {
  const starts: number[] = [];
  let acc = 14;
  for (const line of lines) {
    acc += line.delay;
    starts.push(acc);
    acc += arrival(line) + (line.pause ?? 0);
  }

  const scrollSteps: { start: number; delta: number }[] = [];
  let target = 0;
  let bottom = 0;
  for (const [i, start] of starts.entries()) {
    bottom += heightOf(lines[i]);
    const next = Math.max(target, bottom - VIEW_H);
    if (next > target) {
      scrollSteps.push({ delta: next - target, start });
      target = next;
    }
  }

  return { duration: acc + tailHold, lines, scrollSteps, starts };
};

const REPORT_SCRIPT = makeScript(REPORT_LINES, 76);
const AGENT_SCRIPT = makeScript(AGENT_LINES, 56);

export const AUDIT_REPORT_DURATION = REPORT_SCRIPT.duration;
export const AUDIT_AGENT_DURATION = AGENT_SCRIPT.duration;

const SEVERITY_COLOR: Record<Severity, string> = {
  error: ERROR,
  warning: WARNING,
};
const GLYPH: Record<Severity, string> = { error: "✖", warning: "⚠" };

const TrafficLight = ({ color }: { color: string }) => (
  <span
    style={{
      background: color,
      borderRadius: 999,
      display: "inline-block",
      height: 11,
      width: 11,
    }}
  />
);

// The Codex startup banner — a bordered box, like the real CLI draws (with a
// CSS border rather than box-drawing glyphs, which gap at this line height).
const CodexBanner = () => (
  <div style={{ height: BANNER_H, paddingTop: 8 }}>
    <div
      style={{
        border: "1px solid rgba(0,0,0,0.22)",
        borderRadius: 8,
        display: "inline-block",
        padding: "11px 16px",
      }}
    >
      <div
        style={{
          color: INK,
          fontSize: 13.5,
          fontWeight: 600,
          lineHeight: "20px",
        }}
      >
        {CODEX_BANNER.title}
      </div>
      <div style={{ marginTop: 8 }}>
        {CODEX_BANNER.rows.map((row) => (
          <div
            key={row.label}
            style={{ fontSize: 13.5, lineHeight: "21px", whiteSpace: "pre" }}
          >
            <span style={{ color: FAINT }}>{row.label}</span>
            <span style={{ color: INK }}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// The echoed agent prompt on a subtle panel, wrapping naturally — paragraph
// groups separated by a gap, lines within a group stacked directly.
const CodexPrompt = () => (
  <div style={{ height: PROMPT_H, paddingTop: 10 }}>
    <div
      style={{
        background: "rgba(0,0,0,0.05)",
        borderRadius: 8,
        height: PROMPT_H - 10,
        overflow: "hidden",
        padding: "14px 16px",
      }}
    >
      <div style={{ paddingLeft: 22, position: "relative" }}>
        <span style={{ color: ACCENT, left: 0, position: "absolute" }}>›</span>
        {CODEX_PROMPT.map((group, groupIndex) => (
          <div
            key={group[0]}
            style={{
              color: groupIndex === 0 ? INK : MUTED,
              fontSize: 13,
              lineHeight: "20px",
              marginTop: groupIndex === 0 ? 0 : 14,
              whiteSpace: "normal",
            }}
          >
            {group.map((text) => (
              <div key={text}>{text}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  </div>
);

const LineBody = ({ line }: { line: TermLine }) => {
  switch (line.kind) {
    case "blank": {
      return null;
    }
    case "header": {
      return (
        <>
          <span style={{ color: INK, fontWeight: 600 }}>{"  blume audit"}</span>
          <span style={{ color: FAINT }}>{`  ${line.meta}`}</span>
        </>
      );
    }
    case "summary": {
      return <span style={{ color: MUTED }}>{`  ${line.text}`}</span>;
    }
    case "category": {
      return (
        <span style={{ color: INK, fontWeight: 600 }}>{`  ${line.text}`}</span>
      );
    }
    case "finding": {
      const color = SEVERITY_COLOR[line.severity ?? "error"];
      return (
        <>
          <span style={{ color }}>
            {`  ${GLYPH[line.severity ?? "error"]} ${line.text}`}
          </span>
          <span style={{ color: FAINT }}>{`  ${line.meta}`}</span>
        </>
      );
    }
    case "page": {
      return (
        <>
          <span
            style={{ color: MUTED, display: "inline-block", width: URL_COL_W }}
          >
            {`      ${line.text}`}
          </span>
          <span style={{ color: FAINT }}>{line.file}</span>
        </>
      );
    }
    case "more": {
      return <span style={{ color: FAINT }}>{`      ${line.text}`}</span>;
    }
    case "fix": {
      return <span style={{ color: ACCENT }}>{`      ${line.text}`}</span>;
    }
    case "hand": {
      return <span style={{ color: INK }}>{`  ${line.text}`}</span>;
    }
    case "banner": {
      return <CodexBanner />;
    }
    case "prompt": {
      return <CodexPrompt />;
    }
    case "ok": {
      return (
        <span style={{ color: GREEN, fontWeight: 600 }}>
          {`  ${line.text}`}
        </span>
      );
    }
    default: {
      return null;
    }
  }
};

const TerminalCard = ({ script }: { script: TermScript }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { lines, scrollSteps, starts } = script;

  const cardOpacity = interpolate(frame, [0, 14], [0, 1], clamp);
  const cardScale = interpolate(frame, [0, 20], [0.985, 1], {
    ...clamp,
    easing: EASE,
  });
  const cardY = interpolate(frame, [0, 20], [18, 0], {
    ...clamp,
    easing: EASE,
  });

  const scroll = scrollSteps.reduce(
    (acc, step) =>
      acc +
      interpolate(frame, [step.start, step.start + 16], [0, step.delta], {
        ...clamp,
        easing: EASE,
      }),
    0
  );

  const cursorOn = Math.floor((frame / fps) * 2) % 2 === 0;
  let activeIndex = -1;
  for (const [i, start] of starts.entries()) {
    if (frame >= start) {
      activeIndex = i;
    }
  }

  const cardStyle = {
    // oxlint-disable-next-line react-doctor/no-large-animated-blur -- intentional video visual — frosted-glass blur radius tuned for launch render
    WebkitBackdropFilter: "blur(16px)",
    // oxlint-disable-next-line react-doctor/no-large-animated-blur -- intentional video visual — frosted-glass blur radius tuned for launch render
    backdropFilter: "blur(16px)",
    background: "rgba(255,255,255,0.82)",
    border: "1px solid rgba(255,255,255,0.85)",
    borderRadius: 14,
    boxShadow:
      "0 30px 70px rgba(30,40,60,0.24), inset 0 1px 0 rgba(255,255,255,0.8)",
    height: CARD_H,
    opacity: cardOpacity,
    overflow: "hidden",
    transform: `translateY(${cardY}px) scale(${cardScale})`,
    width: CARD_W,
  } as const;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={cardStyle}>
        {/* terminal chrome */}
        <div
          style={{
            alignItems: "center",
            borderBottom: `1px solid ${CHROME_BORDER}`,
            display: "flex",
            gap: 8,
            height: CHROME_H,
            padding: "0 16px",
            position: "relative",
          }}
        >
          <TrafficLight color="#ff5f57" />
          <TrafficLight color="#febc2e" />
          <TrafficLight color="#28c840" />
          <div
            style={{
              color: MUTED,
              fontFamily: MONO,
              fontSize: 13,
              left: 0,
              position: "absolute",
              right: 0,
              textAlign: "center",
            }}
          >
            ~/acme
          </div>
          <div
            style={{
              color: INK,
              fontFamily: SANS,
              fontSize: 14,
              fontWeight: 600,
              marginLeft: "auto",
            }}
          >
            Terminal
          </div>
        </div>

        {/* scrolling buffer */}
        <div
          style={{
            height: VIEW_H,
            marginTop: PAD_TOP,
            overflow: "hidden",
            padding: `0 ${PAD_X}px`,
          }}
        >
          <div
            style={{
              fontFamily: MONO,
              fontSize: 14.5,
              lineHeight: `${LINE_H}px`,
              transform: `translateY(${-scroll}px)`,
            }}
          >
            {lines.map((line, i) => {
              if (frame < starts[i]) {
                return null;
              }
              const local = frame - starts[i];
              const landed = interpolate(local, [0, 4], [0, 1], clamp);

              if (line.kind === "cmd") {
                const revealed = Math.min(
                  line.text?.length ?? 0,
                  Math.floor(local * CHARS_PER_FRAME)
                );
                const typing = revealed < (line.text?.length ?? 0);
                const showCursor = i === activeIndex && typing && cursorOn;
                return (
                  <div
                    key={`${line.kind}-${i}`}
                    style={{
                      alignItems: "center",
                      display: "flex",
                      height: LINE_H,
                      whiteSpace: "pre",
                    }}
                  >
                    <span style={{ color: ACCENT, marginRight: 8 }}>$</span>
                    <span style={{ color: INK }}>
                      {line.text?.slice(0, revealed)}
                    </span>
                    {showCursor && (
                      <span
                        style={{
                          background: INK,
                          display: "inline-block",
                          height: 15,
                          marginLeft: 2,
                          transform: "translateY(2px)",
                          width: 8,
                        }}
                      />
                    )}
                  </div>
                );
              }

              return (
                <div
                  key={`${line.kind}-${i}`}
                  style={{
                    height: heightOf(line),
                    opacity: landed,
                    whiteSpace: "pre",
                  }}
                >
                  <LineBody line={line} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const AuditReport = () => <TerminalCard script={REPORT_SCRIPT} />;
export const AuditAgent = () => <TerminalCard script={AGENT_SCRIPT} />;
