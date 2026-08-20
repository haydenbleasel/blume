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
import { AGENT_CHECKS_DURATION, AgentChecks } from "@/scenes/agent-checks";
import {
  AGENT_BUILD_DURATION,
  AGENT_CURL_DURATION,
  AgentBuild,
  AgentCurl,
} from "@/scenes/agent-ready-terminal";
import { BlumeLogo } from "@/scenes/blume-logo";

// The agent-readiness release video. Same visual system as the audit and eval
// cuts — gradient photo backdrop, frosted cards, Geist — arranged
// problem-first: agents are probing your docs for machine-readable answers;
// this release publishes every one of them from the build you already run.

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
// so the claim lands as a beat, not a single flash.
const SceneTagline = () => (
  <>
    <Positioned dy={-37}>
      <SoftBlurIn
        text="Your docs have new readers."
        fontSize={70}
        color={WHITE}
      />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={37}>
        <SoftBlurIn
          text="Most of them aren’t human."
          fontSize={70}
          color={WHITE}
        />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 2 · The checklist ────────────────────────────────────────────────
// The problem, made concrete: a fixed headline over a scrolling pile of
// agent-readiness requirement cards — the standards a docs site is now
// expected to answer, and the ones this release wires into the harness.
const SceneChecks = () => <AgentChecks />;

// ─── Scene 3 · The solution ─────────────────────────────────────────────────
// The pivot, in the tagline's two-line rhythm.
const SOLUTION_DURATION = 80;

const SceneSolution = () => (
  <>
    <Positioned dy={-34}>
      <SoftBlurIn
        text="Blume publishes the answers"
        fontSize={56}
        color={WHITE}
      />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={34}>
        <SoftBlurIn
          text="agents actually look for"
          fontSize={56}
          color={WHITE}
        />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 4 · The front door ───────────────────────────────────────────────
// A frosted terminal: `curl -I` shows the discovery Link headers, then the
// same page comes back as Markdown via `Accept: text/markdown`.
const SceneCurl = () => <AgentCurl />;

// ─── Scene 5 · The pivot ────────────────────────────────────────────────────
const PIVOT_DURATION = 80;

const ScenePivot = () => (
  <>
    <Positioned dy={-34}>
      <SoftBlurIn
        text="The whole discovery layer,"
        fontSize={56}
        color={WHITE}
      />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={34}>
        <SoftBlurIn
          text="from the build you already run"
          fontSize={56}
          color={WHITE}
        />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 6 · The build ────────────────────────────────────────────────────
// The same frosted card: `blume build` emits every discovery artifact, then
// `tree dist/.well-known` shows what landed.
const SceneBuild = () => <AgentBuild />;

// ─── Scene 7 · The feature run ──────────────────────────────────────────────
const SNAPS = [
  "Agent-ready by default.",
  "Link headers. API catalog.",
  "Server card. Agent skills.",
  "WebMCP tools on every page.",
  "Zero config… mostly.",
];

const FEATURES_DURATION = rattleDuration(SNAPS);

const SceneFeatures = () => (
  <Rattle lines={SNAPS} fontSize={64} animateFirstIn />
);

// ─── Scene 8 · The close ────────────────────────────────────────────────────
const SceneCta = () => (
  // Transparent so the background carries through, with the caret running out
  // to the final frame.
  <Sequence durationInFrames={90} layout="none">
    <Typewriter
      text="npm i blume"
      fontSize={64}
      charsPerSecond={16}
      color={WHITE}
      cursorColor={WHITE}
      background="transparent"
    />
  </Sequence>
);

// ─── Scene 9 · Logo sign-off ────────────────────────────────────────────────
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
const CHECKS_END = TAGLINE_END + AGENT_CHECKS_DURATION;
const SOLUTION_END = CHECKS_END + SOLUTION_DURATION;
const CURL_END = SOLUTION_END + AGENT_CURL_DURATION;
const PIVOT_END = CURL_END + PIVOT_DURATION;
const BUILD_END = PIVOT_END + AGENT_BUILD_DURATION;
const FEATURES_END = BUILD_END + FEATURES_DURATION;
const CTA_END = FEATURES_END + 90;
export const AGENT_READY_VIDEO_DURATION = CTA_END + 90;

export const AgentReadyVideo = () => {
  const { width } = useVideoConfig();
  const stageScale = width / REF_W;

  return (
    <AbsoluteFill style={FONT_VARS}>
      {/* Gradient photo backdrop, behind every scene — fills the full frame. */}
      <AbsoluteFill>
        <Img
          src={staticFile("background.jpg")}
          style={{ height: "100%", objectFit: "cover", width: "100%" }}
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
            durationInFrames={AGENT_CHECKS_DURATION}
            layout="none"
          >
            <SceneChecks />
          </Sequence>
          <Sequence
            from={CHECKS_END}
            durationInFrames={SOLUTION_DURATION}
            layout="none"
          >
            <SceneSolution />
          </Sequence>
          <Sequence
            from={SOLUTION_END}
            durationInFrames={AGENT_CURL_DURATION}
            layout="none"
          >
            <SceneCurl />
          </Sequence>
          <Sequence
            from={CURL_END}
            durationInFrames={PIVOT_DURATION}
            layout="none"
          >
            <ScenePivot />
          </Sequence>
          <Sequence
            from={PIVOT_END}
            durationInFrames={AGENT_BUILD_DURATION}
            layout="none"
          >
            <SceneBuild />
          </Sequence>
          <Sequence
            from={BUILD_END}
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
