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
  TRANSLATE_CONFIG_DURATION,
  TRANSLATE_RUN_DURATION,
  TranslateConfig,
  TranslateRun,
} from "@/scenes/translate-terminal";

// The `blume translate` launch video (1.4). Same visual system as the audit
// and eval cuts — gradient photo backdrop, frosted cards, Geist — but opening
// cold on the title itself rattling through the locales. Declare them once,
// and `blume translate` fills them in.

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
  firstHold = 40,
  beat = 40,
}: {
  lines: string[];
  fontSize: number;
  animateFirstIn?: boolean;
  /** Frames the first line holds before the swaps start — stretch it when the
   * rattle opens the video and the first line has to register as a title. */
  firstHold?: number;
  /** Frames per swap — stretch it when the lines run long enough that the
   * standard snap cadence outpaces reading them. */
  beat?: number;
}) => (
  <>
    <Sequence durationInFrames={firstHold} layout="none">
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
          from={firstHold + i * beat}
          durationInFrames={isLast ? 70 : beat}
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

const rattleDuration = (lines: string[], firstHold = 40, beat = 40): number =>
  firstHold + beat * (lines.length - 2) + 70;

// ─── Scene 1 · The title ────────────────────────────────────────────────────
// No tagline this time: the video opens cold on the title, which then rattles
// through the four locales the config declares two scenes later. Geist has no
// CJK faces, so the ja/zh lines fall through to the system stack — acceptable
// at this size and cadence.
const TITLE_HOLD = 30;

const TITLES = [
  "Your docs, built for everyone",
  "Deine Docs, für alle gemacht",
  "Tus docs, hechos para todos",
  "ドキュメントを、すべての人へ",
  "你的文档，为每个人而建",
];

const TITLE_DURATION = rattleDuration(TITLES, TITLE_HOLD);

const SceneTitle = () => (
  <Rattle lines={TITLES} fontSize={64} animateFirstIn firstHold={TITLE_HOLD} />
);

// ─── Scene 2 · The solution ─────────────────────────────────────────────────
// The pivot, in the two-line blur-in rhythm the earlier cuts open with —
// smaller face so the long first line clears the stage edges.
const SOLUTION_DURATION = 80;

const SceneSolution = () => (
  <>
    <Positioned dy={-34}>
      <SoftBlurIn
        text="Ship docs in every language"
        fontSize={56}
        color={WHITE}
      />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={34}>
        <SoftBlurIn text="with Blume Translate" fontSize={56} color={WHITE} />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 3 · The config ───────────────────────────────────────────────────
// The solution starts: the locales, declared once in blume.config.ts.
const SceneConfig = () => <TranslateConfig />;

// ─── Scene 4 · The run ──────────────────────────────────────────────────────
// The same frosted card, now a terminal: `blume translate` fills every locale.
const SceneRun = () => <TranslateRun />;

// ─── Scene 5 · The craft ────────────────────────────────────────────────────
// The production-grade details in a split layout: the title sits top-left,
// and the three bullets land one by one top-right, accumulating instead of
// swapping. Every claim mirrors the implementation: the committed
// blume.translations.json ledger stamps each page at its source hash, each
// locale's `style` rides into the prompt, and retranslations get the previous
// translation with a change-only-what-drifted instruction.
const CRAFT_TITLE = "Production-grade translation";

const CRAFT_DETAILS = [
  "A committed ledger pins every page to its source hash",
  "Choose each locale's voice: formal, informal, dialect",
  "Retranslations reuse the prior version, so diffs stay small",
];

const CRAFT_BULLET_FROM = 24;
const CRAFT_BULLET_EVERY = 42;

const CRAFT_DURATION =
  CRAFT_BULLET_FROM + (CRAFT_DETAILS.length - 1) * CRAFT_BULLET_EVERY + 90;

const CRAFT_EASE = Easing.bezier(0.22, 1, 0.36, 1);
const CRAFT_CLAMP = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

const SceneCraft = () => {
  const frame = useCurrentFrame();

  // The fade/lift the frosted cards enter with, re-anchored per element.
  const enter = (from: number) => ({
    opacity: interpolate(frame - from, [0, 14], [0, 1], CRAFT_CLAMP),
    transform: `translateY(${interpolate(frame - from, [0, 20], [14, 0], {
      ...CRAFT_CLAMP,
      easing: CRAFT_EASE,
    })}px)`,
  });

  return (
    <AbsoluteFill>
      <div
        style={{
          color: WHITE,
          fontFamily: SANS,
          fontSize: 64,
          fontWeight: 600,
          left: 90,
          letterSpacing: "-0.03em",
          lineHeight: 1.08,
          position: "absolute",
          top: 84,
          width: 540,
          ...enter(0),
        }}
      >
        {CRAFT_TITLE}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 34,
          left: 700,
          position: "absolute",
          right: 80,
          top: 84,
        }}
      >
        {CRAFT_DETAILS.map((line, i) => (
          <div
            key={line}
            style={{
              color: WHITE,
              display: "flex",
              fontFamily: SANS,
              fontSize: 32,
              fontWeight: 500,
              gap: 16,
              letterSpacing: "-0.01em",
              lineHeight: 1.3,
              ...enter(CRAFT_BULLET_FROM + i * CRAFT_BULLET_EVERY),
            }}
          >
            <span
              style={{
                background: "rgba(255,255,255,0.55)",
                borderRadius: 999,
                flexShrink: 0,
                height: 9,
                marginTop: 16,
                width: 9,
              }}
            />
            <span>{line}</span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// ─── Scene 6 · The feature run ──────────────────────────────────────────────
const SNAPS = [
  "Sidebars and UI chrome, localized.",
  "Uses your local agent CLI.",
  "Incremental: only stale pages rerun.",
  "Hand edits adopted, never overwritten.",
  "Drift fails CI before readers notice.",
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
      text="blume translate"
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
const TITLE_END = TITLE_DURATION;
const SOLUTION_END = TITLE_END + SOLUTION_DURATION;
const CONFIG_END = SOLUTION_END + TRANSLATE_CONFIG_DURATION;
const RUN_END = CONFIG_END + TRANSLATE_RUN_DURATION;
const CRAFT_END = RUN_END + CRAFT_DURATION;
const FEATURES_END = CRAFT_END + FEATURES_DURATION;
const CTA_END = FEATURES_END + 90;
export const TRANSLATE_VIDEO_DURATION = CTA_END + 90;

export const TranslateVideo = () => {
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
          <Sequence durationInFrames={TITLE_DURATION} layout="none">
            <SceneTitle />
          </Sequence>
          <Sequence
            from={TITLE_END}
            durationInFrames={SOLUTION_DURATION}
            layout="none"
          >
            <SceneSolution />
          </Sequence>
          <Sequence
            from={SOLUTION_END}
            durationInFrames={TRANSLATE_CONFIG_DURATION}
            layout="none"
          >
            <SceneConfig />
          </Sequence>
          <Sequence
            from={CONFIG_END}
            durationInFrames={TRANSLATE_RUN_DURATION}
            layout="none"
          >
            <SceneRun />
          </Sequence>
          <Sequence
            from={RUN_END}
            durationInFrames={CRAFT_DURATION}
            layout="none"
          >
            <SceneCraft />
          </Sequence>
          <Sequence
            from={CRAFT_END}
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
