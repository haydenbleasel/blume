"use client";

import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// The two eval frosted-card scenes, sharing one card frame so the file cuts
// to the terminal without the stage changing shape:
//   EvalYaml — the user's questions land in evals.yaml, line by line.
//   EvalRun — `blume eval` streams the per-question results (glyph, id,
//   status, score, time, spend — exactly the shape the real CLI prints).

const MONO = "var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace";

const INK = "rgba(0,0,0,0.85)";
const MUTED = "rgba(0,0,0,0.55)";
const FAINT = "rgba(0,0,0,0.34)";
const ACCENT = "#009696";
const ERROR = "#d64545";
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
// Real report columns: the padded id before the status cells (22 mono chars
// at 14.5px ≈ 8.7px each).
const ID_COL_W = 192;

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const CHARS_PER_FRAME = 2;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// ─── The evals file ─────────────────────────────────────────────────────────
// The questions the rattle scene just asked, written down in the real
// evals.yaml shape (id, question, expected facts) — the same ids the terminal
// grades next scene.

interface YamlLine {
  /** Nesting depth, two spaces each. */
  depth?: number;
  /** `- ` list marker before the key or item. */
  dash?: boolean;
  /** `key:` — rendered accent, with the value (if any) in ink. */
  key?: string;
  value?: string;
  /** A plain list item (an expected fact). */
  item?: string;
}

const YAML_LINES: YamlLine[] = [
  { key: "questions" },
  { dash: true, depth: 1, key: "id", value: "install-node-version" },
  { depth: 2, key: "question", value: "What Node version do I need?" },
  { depth: 2, key: "expected" },
  { depth: 3, item: "Node 22.12 or newer" },
  { dash: true, depth: 1, key: "id", value: "rotate-api-keys" },
  { depth: 2, key: "question", value: "How do I rotate an API key?" },
  { depth: 2, key: "expected" },
  { depth: 3, item: "keys can be rotated from the dashboard" },
  { dash: true, depth: 1, key: "id", value: "webhook-retries" },
  { depth: 2, key: "question", value: "Why is my webhook retrying?" },
  { depth: 2, key: "expected" },
  { depth: 3, item: "failed deliveries retry with exponential backoff" },
  { dash: true, depth: 1, key: "id", value: "sso-saml-setup" },
  { depth: 2, key: "question", value: "Do you support SAML SSO?" },
  { depth: 2, key: "expected" },
  { depth: 3, item: "SAML SSO is available on the Enterprise plan" },
  { depth: 2, key: "skip", value: "true" },
];

// Card entry (14) + one landing beat per line + a hold to read the file.
const YAML_STAGGER = 3;
export const EVAL_YAML_DURATION = 14 + YAML_LINES.length * YAML_STAGGER + 80;

// ─── The terminal run ───────────────────────────────────────────────────────

type QuestionStatus = "fail" | "pass" | "skip";

interface TermLine {
  kind: "cmd" | "blank" | "header" | "question" | "missing" | "fix" | "summary";
  text?: string;
  /** header: the dim `questions · agent` tail. */
  meta?: string;
  /** question lines: the kebab-case id from the evals file. */
  id?: string;
  status?: QuestionStatus;
  /** question lines: the judge's score / wall clock / spend cells. */
  score?: string;
  time?: string;
  cost?: string;
  /** fix lines: the source file that resolves the finding. */
  file?: string;
  /** Frames after the previous line finishes before this one lands. */
  delay: number;
  /** Extra hold after this line, before the next starts. */
  pause?: number;
}

const HEADER_META = "8 questions · Codex, GPT 5.6 Sol";
// Counts that add up: 5 passed + 2 failed + 1 skipped = the 8 in the header,
// and the summary time/spend are the per-question cells summed.
const SUMMARY = "5 passed · 2 failed · 1 skipped · 2m 9s · $1.05";

// The script. Copy mirrors `formatEvalReport` in
// packages/blume/src/eval/report.ts — real line shapes, real fix strings, the
// staggered delays standing in for each question's reader/judge run.
const RUN_LINES: TermLine[] = [
  { delay: 16, kind: "cmd", text: "blume eval" },
  { delay: 10, kind: "blank" },
  { delay: 0, kind: "header", meta: HEADER_META },
  { delay: 4, kind: "blank" },
  {
    cost: "$0.11",
    delay: 10,
    id: "install-node-version",
    kind: "question",
    score: "1.00",
    status: "pass",
    time: "12.4s",
  },
  {
    cost: "$0.09",
    delay: 8,
    id: "quickstart-first-run",
    kind: "question",
    score: "1.00",
    status: "pass",
    time: "10.8s",
  },
  {
    cost: "$0.31",
    delay: 12,
    id: "webhook-retries",
    kind: "question",
    score: "0.50",
    status: "fail",
    time: "38.9s",
  },
  {
    delay: 2,
    kind: "missing",
    text: "missing: failed deliveries retry with exponential backoff",
  },
  {
    cost: "$0.12",
    delay: 8,
    id: "config-file-basics",
    kind: "question",
    score: "1.00",
    status: "pass",
    time: "14.1s",
  },
  {
    cost: "$0.10",
    delay: 8,
    id: "rate-limit-headers",
    kind: "question",
    score: "1.00",
    status: "pass",
    time: "11.6s",
  },
  {
    cost: "$0.08",
    delay: 8,
    id: "api-error-codes",
    kind: "question",
    score: "1.00",
    status: "pass",
    time: "9.7s",
  },
  {
    cost: "$0.24",
    delay: 10,
    id: "rotate-api-keys",
    kind: "question",
    score: "0.33",
    status: "fail",
    time: "31.2s",
  },
  {
    delay: 2,
    kind: "missing",
    text: "missing: keys can be rotated from the dashboard",
  },
  { delay: 6, id: "sso-saml-setup", kind: "question", status: "skip" },
  { delay: 6, kind: "blank" },
  {
    delay: 0,
    file: "docs/guides/webhooks.mdx",
    kind: "fix",
    text: 'Docs could not answer: "Why is my webhook retrying?"',
  },
  {
    delay: 3,
    file: "docs/guides/api-keys.mdx",
    kind: "fix",
    text: 'Docs could not answer: "How do I rotate an API key?"',
  },
  { delay: 4, kind: "blank" },
  { delay: 0, kind: "summary", text: SUMMARY },
];

/** Frames a line spends arriving: cmd lines type, output lines just land. */
const arrival = (line: TermLine): number =>
  line.kind === "cmd"
    ? Math.ceil((line.text?.length ?? 0) / CHARS_PER_FRAME)
    : 0;

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
  for (const start of starts) {
    bottom += LINE_H;
    const next = Math.max(target, bottom - VIEW_H);
    if (next > target) {
      scrollSteps.push({ delta: next - target, start });
      target = next;
    }
  }

  return { duration: acc + tailHold, lines, scrollSteps, starts };
};

const RUN_SCRIPT = makeScript(RUN_LINES, 76);

export const EVAL_RUN_DURATION = RUN_SCRIPT.duration;

const STATUS_COLOR = {
  fail: ERROR,
  pass: GREEN,
  skip: FAINT,
} satisfies Record<QuestionStatus, string>;
const GLYPH = {
  fail: "✖",
  pass: "✔",
  skip: "⊘",
} satisfies Record<QuestionStatus, string>;

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

// The shared frosted card: chrome bar (traffic lights, centered title) over a
// clipped content viewport, entering with the same fade/lift both scenes use.
const FrostedCard = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => {
  const frame = useCurrentFrame();

  const cardOpacity = interpolate(frame, [0, 14], [0, 1], clamp);
  const cardScale = interpolate(frame, [0, 20], [0.985, 1], {
    ...clamp,
    easing: EASE,
  });
  const cardY = interpolate(frame, [0, 20], [18, 0], {
    ...clamp,
    easing: EASE,
  });

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
            {title}
          </div>
        </div>
        <div
          style={{
            height: VIEW_H,
            marginTop: PAD_TOP,
            overflow: "hidden",
            padding: `0 ${PAD_X}px`,
          }}
        >
          {children}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── EvalYaml ───────────────────────────────────────────────────────────────
const YamlBody = ({ line }: { line: YamlLine }) => {
  const lead = "  ".repeat(line.depth ?? 0);
  return (
    <>
      <span style={{ color: FAINT }}>{`${lead}${line.dash ? "- " : ""}`}</span>
      {line.key && (
        <>
          <span style={{ color: ACCENT }}>{line.key}</span>
          <span style={{ color: FAINT }}>:</span>
        </>
      )}
      {line.value && <span style={{ color: INK }}>{` ${line.value}`}</span>}
      {line.item && (
        <>
          <span style={{ color: FAINT }}>{"- "}</span>
          <span style={{ color: MUTED }}>{line.item}</span>
        </>
      )}
    </>
  );
};

export const EvalYaml = () => {
  const frame = useCurrentFrame();

  return (
    <FrostedCard title="evals.yaml">
      <div
        style={{ fontFamily: MONO, fontSize: 14.5, lineHeight: `${LINE_H}px` }}
      >
        {YAML_LINES.map((line, i) => {
          const start = 14 + i * YAML_STAGGER;
          if (frame < start) {
            return null;
          }
          const landed = interpolate(frame - start, [0, 4], [0, 1], clamp);
          return (
            <div
              key={`${line.key ?? line.item}-${i}`}
              style={{ height: LINE_H, opacity: landed, whiteSpace: "pre" }}
            >
              <YamlBody line={line} />
            </div>
          );
        })}
      </div>
    </FrostedCard>
  );
};

// ─── EvalRun ────────────────────────────────────────────────────────────────
const LineBody = ({ line }: { line: TermLine }) => {
  switch (line.kind) {
    case "blank": {
      return null;
    }
    case "header": {
      return (
        <>
          <span style={{ color: INK, fontWeight: 600 }}>{"  blume eval"}</span>
          <span style={{ color: FAINT }}>{`  ${line.meta}`}</span>
        </>
      );
    }
    case "question": {
      const status = line.status ?? "pass";
      const color = STATUS_COLOR[status];
      const idStyle = {
        display: "inline-block",
        width: ID_COL_W,
      } as const;
      if (status === "skip") {
        return (
          <>
            <span style={{ color: FAINT }}>{`  ${GLYPH.skip} `}</span>
            <span style={{ ...idStyle, color: MUTED }}>{line.id}</span>
            <span style={{ color: FAINT }}> skipped</span>
          </>
        );
      }
      return (
        <>
          <span style={{ color }}>{`  ${GLYPH[status]} `}</span>
          <span style={{ ...idStyle, color: INK }}>{line.id}</span>
          <span style={{ color }}>{` ${status}`}</span>
          <span style={{ color: MUTED }}>{`  ${line.score}`}</span>
          <span style={{ color: FAINT }}>{`  ${line.time}  ${line.cost}`}</span>
        </>
      );
    }
    case "missing": {
      return <span style={{ color: FAINT }}>{`      ${line.text}`}</span>;
    }
    case "fix": {
      return (
        <>
          <span style={{ color: ACCENT }}>{"  fix: "}</span>
          <span style={{ color: MUTED }}>{line.file}</span>
          <span style={{ color: FAINT }}>{`  ${line.text}`}</span>
        </>
      );
    }
    case "summary": {
      return <span style={{ color: MUTED }}>{`  ${line.text}`}</span>;
    }
    default: {
      return null;
    }
  }
};

export const EvalRun = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { lines, scrollSteps, starts } = RUN_SCRIPT;

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

  return (
    <FrostedCard title="~/acme">
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
                height: LINE_H,
                opacity: landed,
                whiteSpace: "pre",
              }}
            >
              <LineBody line={line} />
            </div>
          );
        })}
      </div>
    </FrostedCard>
  );
};
