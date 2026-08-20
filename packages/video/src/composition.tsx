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

import { EcosystemConstellation } from "@/components/remocn/ecosystem-constellation";
import { SharedAxisY } from "@/components/remocn/shared-axis-y";
import { ShortSlideRight } from "@/components/remocn/short-slide-right";
import { SoftBlurIn } from "@/components/remocn/soft-blur-in";
import { Typewriter } from "@/components/remocn/typewriter";
import { BlumeLogo } from "@/scenes/blume-logo";
import { BLUME_MARK_SVG } from "@/scenes/blume-mark";
import { ChangelogScene } from "@/scenes/changelog-scene";
import { CONTENT_SOURCE_LOGOS } from "@/scenes/content-source-logos";
import { DevPreview } from "@/scenes/dev-preview";
import { SeoAeoScene } from "@/scenes/seo-aeo-scene";

const { fontFamily: GEIST_SANS } = loadGeistSans("normal", {
  subsets: ["latin"],
  weights: ["400", "500", "600", "700", "800"],
});
const { fontFamily: GEIST_MONO } = loadGeistMono("normal", {
  subsets: ["latin"],
  weights: ["400", "500", "600"],
});

// Text rides directly on the gradient photo (no dark overlay).
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

// ─── Scene 1 · The tagline (0–90) ───────────────────────────────────────────
// Two centered lines blur in — the second trails the first by 0.25s (8f @30fps)
// so the value prop lands as a beat, not a single flash.
const SceneTagline = () => (
  <>
    <Positioned dy={-37}>
      <SoftBlurIn text="World-class docs" fontSize={70} color={WHITE} />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={37}>
        <SoftBlurIn
          text="for everything you ship."
          fontSize={70}
          color={WHITE}
        />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 2 · The money shot (90–510) ──────────────────────────────────────
// One glassy card: the terminal runs `blume init` → `blume dev`, the live docs
// site loads in, then it splits into source (left) / rendered content (right).
const SceneMoneyShot = () => <DevPreview />;

// ─── Scene 4 · The feature run (766–996) ────────────────────────────────────
const SNAPS = [
  "Zero config setup.",
  "No framework runtime.",
  "Search built in.",
  "Supports OpenAPI schema.",
  "30+ built-in components.",
];

const SceneFeatures = () => (
  <>
    {/* First claim lands hard, then each swap walks down the list. The final
        swap holds longer (one 40f beat per snap) so the last claim rests on
        screen before the cut. */}
    <Sequence durationInFrames={40} layout="none">
      <CenteredLine text={SNAPS[0]} />
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
          <SharedAxisY fromText={SNAPS[i]} toText={snap} color={WHITE} />
        </Sequence>
      );
    })}
  </>
);

// ─── Scene 5 · Serve content from anywhere (996–1101) ───────────────────────
const SceneContentSources = () => (
  <>
    <EcosystemConstellation
      centerLogo={BLUME_MARK_SVG}
      satellites={CONTENT_SOURCE_LOGOS}
      accentColor={WHITE}
    />
    <Sequence from={20} durationInFrames={85} layout="none">
      <Positioned dy={245}>
        <ShortSlideRight
          text="Serve content from anywhere."
          fontSize={48}
          color={WHITE}
        />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 6 · Open source (1101–1191) ──────────────────────────────────────
// Same two-line blur-in as the opening tagline, reprised as a beat before the
// install prompt: the second line trails the first by 0.25s (8f @30fps).
const SceneOpenSource = () => (
  <>
    <Positioned dy={-37}>
      <SoftBlurIn text="Open source" fontSize={70} color={WHITE} />
    </Positioned>
    <Sequence from={8} layout="none">
      <Positioned dy={37}>
        <SoftBlurIn text="Free forever" fontSize={70} color={WHITE} />
      </Positioned>
    </Sequence>
  </>
);

// ─── Scene 7 · The close (1191–1281) ────────────────────────────────────────
const SceneCta = () => (
  // The close — transparent so the background carries through, with the caret
  // running out to the final frame.
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

// ─── Scene 8 · Logo sign-off (1281–1371) ────────────────────────────────────
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

export const LaunchVideo = () => {
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
          <Sequence durationInFrames={90} layout="none">
            <SceneTagline />
          </Sequence>
          <Sequence from={90} durationInFrames={420} layout="none">
            <SceneMoneyShot />
          </Sequence>
          <Sequence from={510} durationInFrames={145} layout="none">
            <SeoAeoScene />
          </Sequence>
          <Sequence from={655} durationInFrames={111} layout="none">
            <ChangelogScene />
          </Sequence>
          <Sequence from={766} durationInFrames={230} layout="none">
            <SceneFeatures />
          </Sequence>
          <Sequence from={996} durationInFrames={105} layout="none">
            <SceneContentSources />
          </Sequence>
          <Sequence from={1101} durationInFrames={90} layout="none">
            <SceneOpenSource />
          </Sequence>
          <Sequence from={1191} durationInFrames={90} layout="none">
            <SceneCta />
          </Sequence>
          <Sequence from={1281} durationInFrames={90} layout="none">
            <SceneLogo />
          </Sequence>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Kept for backwards-compat with the previous stub export.
export const MyComposition = LaunchVideo;
