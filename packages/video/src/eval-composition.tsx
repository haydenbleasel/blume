"use client";

import { loadFont as loadGeistSans } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { SharedAxisY } from "@/components/remocn/shared-axis-y";
import { SoftBlurIn } from "@/components/remocn/soft-blur-in";
import { Typewriter } from "@/components/remocn/typewriter";
import { BlumeLogo } from "@/scenes/blume-logo";
import {
  EVAL_RUN_DURATION,
  EVAL_YAML_DURATION,
  EvalRun,
  EvalYaml,
} from "@/scenes/eval-terminal";

// The `blume eval` launch video. Same visual system as the audit cut —
// gradient photo backdrop, frosted cards, Geist — arranged problem-first:
// humans and agents ask your docs questions; are they getting the right
// answers? Write the questions down, and `blume eval` finds out.

const { fontFamily: GEIST_SANS } = loadGeistSans("normal", {
  subsets: ["latin"],
  weights: ["400", "500", "600", "700", "800"],
});
const { fontFamily: GEIST_MONO } = loadGeistMono("normal", {
  subsets: ["latin"],
  weights: ["400", "500", "600"],
});

const WHITE = "#ffffff";
const SANS =
  "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif";

// Nudge a full-frame, self-centering component off-center without touching its
// internals: translate the frame it lays itself out in.
const Positioned = ({
  dx = 0,
  dy = 0,
  children,
}: {
  dx?: number;
  dy?: number;
  children: ReactNode;
}) => (
  <div
    style={{
      inset: 0,
      position: "absolute",
      transform: `translate(${dx}px, ${dy}px)`,
    }}
  >
    {children}
  </div>
);

// A hard, non-animated line — the punchy first snap of a rattle run.
const CenteredLine = ({
  text,
  fontSize = 72,
}: {
  text: string;
  fontSize?: number;
}) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
    <span
      style={{
        color: WHITE,
        fontFamily: SANS,
        fontSize,
        fontWeight: 600,
        letterSpacing: "-0.03em",
      }}
    >
      {text}
    </span>
  </AbsoluteFill>
);

// A line that rattles itself in: each word pops on the swap cadence
// SharedAxisY uses (5f step-fade, 2f word stagger), with the same word-span
// layout so the handoff to the first swap is pixel-stable.
const WordPopLine = ({
  text,
  fontSize,
}: {
  text: string;
  fontSize: number;
}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <span
        style={{
          color: WHITE,
          fontFamily: SANS,
          fontSize,
          fontWeight: 600,
          letterSpacing: "-0.03em",
        }}
      >
        {text.split(" ").map((word, i) => {
          const opacity = interpolate(frame - 1 - i * 2, [0, 5], [0, 1], {
            easing: Easing.step1,
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <span
              key={`${word}-${i}`}
              style={{
                display: "inline-block",
                marginRight: "0.25em",
                opacity,
              }}
            >
              {word}
            </span>
          );
        })}
      </span>
    </AbsoluteFill>
  );
};

// A rattle: the first line lands hard (or pops in word by word with
// `animateFirstIn`), then each swap walks down the list, with the final swap
// holding longer so the last line rests before the cut.
const Rattle = ({
  lines,
  fontSize,
  animateFirstIn = false,
}: {
  lines: string[];
  fontSize: number;
  animateFirstIn?: boolean;
}) => (
  <>
    <Sequence durationInFrames={40} layout="none">
      {animateFirstIn ? (
        <WordPopLine text={lines[0]} fontSize={fontSize} />
      ) : (
        <CenteredLine text={lines[0]} fontSize={fontSize} />
      )}
    </Sequence>
    {lines.slice(1).map((line, i) => {
      const isLast = i === lines.length - 2;
      return (
        <Sequence
          key={line}
          from={40 + i * 40}
          durationInFrames={isLast ? 70 : 40}
          layout="none"
        >
          <SharedAxisY
            fromText={lines[i]}
            toText={line}
            fontSize={fontSize}
            color={WHITE}
          />
        </Sequence>
      );
    })}
  </>
);

const rattleDuration = (lines: string[]): number =>
  40 * (lines.length - 1) + 70;

// ─── Scene 1 · The setup ────────────────────────────────────────────────────
// Two centered lines blur in — the second trails the first by 0.25s (8f @30fps)
// so the problem lands as a beat, not a single flash.
const SceneTagline = () => (
  <>
    <Positioned dy={-37}>
      <SoftBlurIn text="Humans ask your docs." fontSize={70} color={WHITE} />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={37}>
        <SoftBlurIn text="Now agents do too." fontSize={70} color={WHITE} />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 2 · The questions ────────────────────────────────────────────────
// A rattle of the questions users actually ask — the same ones that land in
// evals.yaml two scenes later.
const QUESTIONS = [
  "What Node version do I need?",
  "How do I rotate an API key?",
  "Why is my webhook retrying?",
  "Do you support SAML SSO?",
];

const QUESTIONS_DURATION = rattleDuration(QUESTIONS);

const SceneQuestions = () => (
  <Rattle lines={QUESTIONS} fontSize={64} animateFirstIn />
);

// ─── Scene 3 · The solution ─────────────────────────────────────────────────
// The pivot, in the tagline's two-line rhythm — smaller face so the long first
// line clears the stage edges.
const SOLUTION_DURATION = 80;

const SceneSolution = () => (
  <>
    <Positioned dy={-34}>
      <SoftBlurIn
        text="Make sure they get the right"
        fontSize={56}
        color={WHITE}
      />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={34}>
        <SoftBlurIn
          text="answers with Blume Evals"
          fontSize={56}
          color={WHITE}
        />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 4 · The evals file ───────────────────────────────────────────────
// The solution starts: those questions, written down in evals.yaml.
const SceneYaml = () => <EvalYaml />;

// ─── Scene 5 · The run ──────────────────────────────────────────────────────
// The same frosted card, now a terminal: `blume eval` grades every question.
const SceneRun = () => <EvalRun />;

// ─── Scene 6 · The feature run ──────────────────────────────────────────────
const SNAPS = [
  "A test suite for your docs.",
  "An agent asks. A judge grades.",
  "No prior knowledge. Docs only.",
  "Uses your local agent CLI.",
  "Fails CI before your users notice.",
];

const FEATURES_DURATION = rattleDuration(SNAPS);

const SceneFeatures = () => (
  <Rattle lines={SNAPS} fontSize={64} animateFirstIn />
);

// ─── Scene 7 · The close ────────────────────────────────────────────────────
const SceneCta = () => (
  // Transparent so the background carries through, with the caret running out
  // to the final frame.
  <Sequence durationInFrames={90} layout="none">
    <Typewriter
      text="blume eval"
      fontSize={64}
      charsPerSecond={16}
      color={WHITE}
      cursorColor={WHITE}
      background="transparent"
    />
  </Sequence>
);

// ─── Scene 8 · Logo sign-off ────────────────────────────────────────────────
// Wordmark trimmed ~20% off the 152 default so it reads a touch tighter next
// to the dot mark, which keeps its size.
const SceneLogo = () => <BlumeLogo color={WHITE} wordmarkSize={122} />;

// Wire the shipped Geist faces to the CSS variables every remocn component
// reads (`var(--font-geist-sans)` / `var(--font-geist-mono)`).
// SAFETY: the object holds only `--*` custom properties — valid inline style
// keys that CSSProperties cannot type in this @types/react version.
const FONT_VARS = {
  "--font-geist-mono": GEIST_MONO,
  "--font-geist-sans": GEIST_SANS,
} as CSSProperties;

// Every scene is authored against this reference stage; the whole tree is scaled
// uniformly to whatever 16:9 resolution the composition is set to (720p → 1080p
// is an exact 1.5×), so nothing has to be re-laid-out per resolution.
const REF_W = 1280;
const REF_H = 720;

// Scene starts, derived so the card scenes can grow without hand-retiming
// everything after them.
const TAGLINE_END = 90;
const QUESTIONS_END = TAGLINE_END + QUESTIONS_DURATION;
const SOLUTION_END = QUESTIONS_END + SOLUTION_DURATION;
const YAML_END = SOLUTION_END + EVAL_YAML_DURATION;
const RUN_END = YAML_END + EVAL_RUN_DURATION;
const FEATURES_END = RUN_END + FEATURES_DURATION;
const CTA_END = FEATURES_END + 90;
export const EVAL_VIDEO_DURATION = CTA_END + 90;

export const EvalVideo = () => {
  const { width } = useVideoConfig();
  const stageScale = width / REF_W;

  return (
    <AbsoluteFill style={FONT_VARS}>
      {/* Gradient photo backdrop, behind every scene — fills the full frame. */}
      <AbsoluteFill>
        <Img
          src={staticFile("background.jpg")}
          style={{ height: "100%", objectFit: "cover", width: "100%" }}
          from={-21}
        />
      </AbsoluteFill>
      {/* Reference stage, scaled from the top-left to fill the frame. */}
      <AbsoluteFill>
        <div
          style={{
            height: REF_H,
            position: "relative",
            transform: `scale(${stageScale})`,
            transformOrigin: "top left",
            width: REF_W,
          }}
        >
          <Sequence durationInFrames={TAGLINE_END} layout="none">
            <SceneTagline />
          </Sequence>
          <Sequence
            from={TAGLINE_END}
            durationInFrames={QUESTIONS_DURATION}
            layout="none"
          >
            <SceneQuestions />
          </Sequence>
          <Sequence
            from={QUESTIONS_END}
            durationInFrames={SOLUTION_DURATION}
            layout="none"
          >
            <SceneSolution />
          </Sequence>
          <Sequence
            from={SOLUTION_END}
            durationInFrames={EVAL_YAML_DURATION}
            layout="none"
          >
            <SceneYaml />
          </Sequence>
          <Sequence
            from={YAML_END}
            durationInFrames={EVAL_RUN_DURATION}
            layout="none"
          >
            <SceneRun />
          </Sequence>
          <Sequence
            from={RUN_END}
            durationInFrames={FEATURES_DURATION}
            layout="none"
          >
            <SceneFeatures />
          </Sequence>
          <Sequence from={FEATURES_END} durationInFrames={90} layout="none">
            <SceneCta />
          </Sequence>
          <Sequence from={CTA_END} durationInFrames={90} layout="none">
            <SceneLogo />
          </Sequence>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
