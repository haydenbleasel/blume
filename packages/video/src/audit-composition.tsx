"use client";

import { loadFont as loadGeistSans } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  staticFile,
  useVideoConfig,
} from "remotion";

import { SharedAxisY } from "@/components/remocn/shared-axis-y";
import { SoftBlurIn } from "@/components/remocn/soft-blur-in";
import { Typewriter } from "@/components/remocn/typewriter";
import {
  AUDIT_AGENT_DURATION,
  AUDIT_REPORT_DURATION,
  AuditAgent,
  AuditReport,
} from "@/scenes/audit-terminal";
import { BlumeLogo } from "@/scenes/blume-logo";

// The Blume 1.1 launch video: `blume audit`. Same visual system as the 1.0
// launch — gradient photo backdrop, frosted cards, Geist — but a tighter cut
// built around one feature.

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

// A hard, non-animated line — the punchy first snap of the feature run.
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

// ─── Scene 1 · The setup ────────────────────────────────────────────────────
// Two centered lines blur in — the second trails the first by 0.25s (8f @30fps)
// so the question lands as a beat, not a single flash.
const SceneTagline = () => (
  <>
    <Positioned dy={-37}>
      <SoftBlurIn text="Your docs are fast." fontSize={70} color={WHITE} />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={37}>
        <SoftBlurIn text="But do they rank?" fontSize={70} color={WHITE} />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 2 · The report ───────────────────────────────────────────────────
// A frosted terminal: `blume audit` dumps the findings report.
const SceneReport = () => <AuditReport />;

// ─── Scene 3 · The question ─────────────────────────────────────────────────
// The pivot between the two terminals, in the tagline's two-line rhythm.
const QUESTION_DURATION = 80;

const SceneQuestion = () => (
  <>
    <Positioned dy={-37}>
      <SoftBlurIn text="But who wants to fix" fontSize={62} color={WHITE} />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={37}>
        <SoftBlurIn text="all that manually?" fontSize={62} color={WHITE} />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 4 · The handoff ──────────────────────────────────────────────────
// The payoff terminal: `--codex` hands the findings to Codex, rerun goes green.
const SceneAgent = () => <AuditAgent />;

// ─── Scene 5 · The feature run ──────────────────────────────────────────────
const SNAPS = [
  "87 checks. Zero setup.",
  "Broken links. Redirect loops.",
  "Open Graph. Sitemaps. robots.txt.",
  "Probes live deployments.",
  "Fails CI before Google notices.",
];

const FEATURES_DURATION = 40 * (SNAPS.length - 1) + 70;

const SceneFeatures = () => (
  <>
    {/* First claim lands hard, then each swap walks down the list. The final
        swap holds longer (one 40f beat per snap) so the last claim rests on
        screen before the cut. */}
    <Sequence durationInFrames={40} layout="none">
      <CenteredLine text={SNAPS[0]} fontSize={64} />
    </Sequence>
    {SNAPS.slice(1).map((snap, i) => {
      const isLast = i === SNAPS.length - 2;
      return (
        <Sequence
          key={snap}
          from={40 + i * 40}
          durationInFrames={isLast ? 70 : 40}
          layout="none"
        >
          <SharedAxisY
            fromText={SNAPS[i]}
            toText={snap}
            fontSize={64}
            color={WHITE}
          />
        </Sequence>
      );
    })}
  </>
);

// ─── Scene 4 · The close ────────────────────────────────────────────────────
const SceneCta = () => (
  // Transparent so the background carries through, with the caret running out
  // to the final frame.
  <Sequence durationInFrames={90} layout="none">
    <Typewriter
      text="blume audit"
      fontSize={64}
      charsPerSecond={16}
      color={WHITE}
      cursorColor={WHITE}
      background="transparent"
    />
  </Sequence>
);

// ─── Scene 5 · Logo sign-off ────────────────────────────────────────────────
// Wordmark trimmed ~20% off the 152 default so it reads a touch tighter next
// to the dot mark, which keeps its size.
const SceneLogo = () => <BlumeLogo color={WHITE} wordmarkSize={122} />;

// Wire the shipped Geist faces to the CSS variables every remocn component
// reads (`var(--font-geist-sans)` / `var(--font-geist-mono)`). Asserted because
// CSSProperties doesn't type custom `--*` keys in this @types/react version.
const FONT_VARS = {
  "--font-geist-mono": GEIST_MONO,
  "--font-geist-sans": GEIST_SANS,
} as CSSProperties;

// Every scene is authored against this reference stage; the whole tree is scaled
// uniformly to whatever 16:9 resolution the composition is set to (720p → 1080p
// is an exact 1.5×), so nothing has to be re-laid-out per resolution.
const REF_W = 1280;
const REF_H = 720;

// Scene starts, derived so the terminal scenes can grow without hand-retiming
// everything after them.
const TAGLINE_END = 90;
const REPORT_END = TAGLINE_END + AUDIT_REPORT_DURATION;
const QUESTION_END = REPORT_END + QUESTION_DURATION;
const AGENT_END = QUESTION_END + AUDIT_AGENT_DURATION;
const FEATURES_END = AGENT_END + FEATURES_DURATION;
const CTA_END = FEATURES_END + 90;
export const AUDIT_VIDEO_DURATION = CTA_END + 90;

export const AuditVideo = () => {
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
            durationInFrames={AUDIT_REPORT_DURATION}
            layout="none"
          >
            <SceneReport />
          </Sequence>
          <Sequence
            from={REPORT_END}
            durationInFrames={QUESTION_DURATION}
            layout="none"
          >
            <SceneQuestion />
          </Sequence>
          <Sequence
            from={QUESTION_END}
            durationInFrames={AUDIT_AGENT_DURATION}
            layout="none"
          >
            <SceneAgent />
          </Sequence>
          <Sequence
            from={AGENT_END}
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
