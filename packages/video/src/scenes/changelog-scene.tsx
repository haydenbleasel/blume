"use client";

import type { ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

// Changelog scene: a left/right split. On the left, a frosted `/changelog`
// timeline card whose entries stagger in — with verbose, bulleted release notes,
// a source toggle that slides from "Manual" to "GitHub Releases", and the
// auto-generated RSS feed. On the right, the title. Copy sourced from
// advanced/changelog.

const SANS =
  "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif";
const MONO = "var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace";

const WHITE = "#ffffff";
const WHITE_MUTED = "rgba(255,255,255,0.78)";
const CHROME_BORDER = "rgba(90,100,120,0.14)";

const INK = "#1f2430";
const MUTED = "#6b7280";
const ACCENT = "#009696";
const RAIL = "rgba(20,28,40,0.14)";

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const CARD_W = 640;
const RIGHT_W = 400;
const DATE_W = 66;
const RAIL_W = 36;
const SEG_W = 150;

interface Entry {
  bullets?: string[];
  category: "Features" | "Fixes" | "Release";
  date: string;
  lead: string;
  version: string;
}

// Newest-first, mirroring the real generated timeline. Tied to the "Comet"
// product used by the docs-site scene so the video reads as one story.
const ENTRIES: Entry[] = [
  {
    bullets: [
      "Queue up to 500 messages in one call with messages.batch.",
      "Automatic webhook retries with exponential backoff.",
    ],
    category: "Features",
    date: "Sep 12",
    lead: "Batch delivery and a rebuilt Node SDK land this release.",
    version: "v2.1.0",
  },
  {
    category: "Fixes",
    date: "Aug 28",
    lead: "Idempotency keys now dedupe across every region, so retried requests never double-send.",
    version: "v2.0.1",
  },
  {
    category: "Release",
    date: "Aug 3",
    lead: "Comet v2 — a faster API, first-class TypeScript types, and a redesigned dashboard.",
    version: "v2.0.0",
  },
];

const TAG_STYLES = {
  Features: { bg: "rgba(0,150,150,0.12)", fg: "#0f7d7d" },
  Fixes: { bg: "rgba(180,83,9,0.12)", fg: "#b45309" },
  Release: { bg: "rgba(111,66,193,0.12)", fg: "#6f42c1" },
} satisfies Record<Entry["category"], { bg: string; fg: string }>;

const rssLabelStyle = {
  alignItems: "center",
  color: MUTED,
  display: "flex",
  fontFamily: SANS,
  fontSize: 12,
  fontWeight: 600,
  gap: 6,
  position: "absolute",
  right: 18,
  top: "50%",
  transform: "translateY(-50%)",
} as const;

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

const GithubIcon = ({ color, size }: { color: string; size: number }) => (
  <svg
    aria-hidden="true"
    fill={color}
    height={size}
    viewBox="0 0 16 16"
    width={size}
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const PencilIcon = ({ color, size }: { color: string; size: number }) => (
  <svg
    aria-hidden="true"
    fill="none"
    height={size}
    stroke={color}
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .622.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </svg>
);

const RssIcon = ({ color, size }: { color: string; size: number }) => (
  <svg
    aria-hidden="true"
    fill="none"
    height={size}
    stroke={color}
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M4 11a9 9 0 0 1 9 9" />
    <path d="M4 4a16 16 0 0 1 16 16" />
    <circle cx={5} cy={19} r={1} />
  </svg>
);

const Segment = ({
  active,
  icon,
  label,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
}) => {
  const segmentStyle = {
    alignItems: "center",
    color: active ? INK : MUTED,
    display: "flex",
    fontFamily: SANS,
    fontSize: 12.5,
    fontWeight: 600,
    gap: 6,
    justifyContent: "center",
    position: "relative",
    width: SEG_W,
    zIndex: 1,
  } as const;

  return (
    <div style={segmentStyle}>
      {icon}
      {label}
    </div>
  );
};

// One release on the vertical rail: a dot, a connecting line (except the last),
// and the version + category tag + a verbose, optionally bulleted note beside it.
const TimelineRow = ({
  entry,
  frame,
  index,
  isLast,
}: {
  entry: Entry;
  frame: number;
  index: number;
  isLast: boolean;
}) => {
  const start = 26 + index * 14;
  const opacity = interpolate(frame, [start, start + 12], [0, 1], clamp);
  const ty = interpolate(frame, [start, start + 12], [8, 0], {
    ...clamp,
    easing: EASE,
  });
  const tag = TAG_STYLES[entry.category];

  return (
    <div style={{ display: "flex", opacity, transform: `translateY(${ty}px)` }}>
      <div
        style={{
          color: MUTED,
          fontFamily: MONO,
          fontSize: 12.5,
          paddingTop: 2,
          textAlign: "right",
          width: DATE_W,
        }}
      >
        {entry.date}
      </div>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          width: RAIL_W,
        }}
      >
        <div
          style={{
            background: index === 0 ? ACCENT : WHITE,
            border: `2px solid ${ACCENT}`,
            borderRadius: 999,
            boxSizing: "border-box",
            height: 13,
            marginTop: 4,
            width: 13,
          }}
        />
        {isLast ? null : (
          <div style={{ background: RAIL, flex: 1, marginTop: 5, width: 2 }} />
        )}
      </div>
      <div style={{ flex: 1, paddingBottom: isLast ? 0 : 26 }}>
        <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
          <span
            style={{
              color: INK,
              fontFamily: SANS,
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "-0.01em",
            }}
          >
            {entry.version}
          </span>
          <span
            style={{
              background: tag.bg,
              borderRadius: 6,
              color: tag.fg,
              fontFamily: SANS,
              // oxlint-disable-next-line react-doctor/no-tiny-text -- intentional video visual — tag type size tuned for launch render
              fontSize: 11.5,
              fontWeight: 600,
              padding: "2px 8px",
            }}
          >
            {entry.category}
          </span>
        </div>
        <div
          style={{
            color: MUTED,
            fontFamily: SANS,
            fontSize: 14.5,
            lineHeight: 1.5,
            marginTop: 6,
          }}
        >
          {entry.lead}
        </div>
        {entry.bullets?.map((bullet) => (
          <div
            key={bullet}
            style={{
              alignItems: "flex-start",
              display: "flex",
              gap: 9,
              marginTop: 7,
            }}
          >
            <span
              style={{
                background: MUTED,
                borderRadius: 999,
                flexShrink: 0,
                height: 4,
                marginTop: 8,
                width: 4,
              }}
            />
            <span
              style={{
                color: MUTED,
                fontFamily: SANS,
                fontSize: 13.5,
                lineHeight: 1.5,
              }}
            >
              {bullet}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const ChangelogScene = () => {
  const frame = useCurrentFrame();

  const cardOpacity = interpolate(frame, [0, 16], [0, 1], clamp);
  const cardScale = interpolate(frame, [0, 22], [0.97, 1], {
    ...clamp,
    easing: EASE,
  });
  const cardX = interpolate(frame, [0, 24], [-44, 0], {
    ...clamp,
    easing: EASE,
  });

  const toolbarOpacity = interpolate(frame, [12, 26], [0, 1], clamp);
  // The source toggle slides from Manual → GitHub Releases: the two ways in.
  const activeX = interpolate(frame, [40, 56], [0, SEG_W], {
    ...clamp,
    easing: EASE,
  });
  const githubActive = activeX >= SEG_W / 2;

  // Right column — the title, sliding in from the right just behind the card.
  const rightX = interpolate(frame, [10, 34], [40, 0], {
    ...clamp,
    easing: EASE,
  });
  const titleOp = interpolate(frame, [26, 48], [0, 1], clamp);
  const titleY = interpolate(frame, [26, 48], [14, 0], {
    ...clamp,
    easing: EASE,
  });
  const subOp = interpolate(frame, [42, 64], [0, 1], clamp);

  const leftCardStyle = {
    // oxlint-disable-next-line react-doctor/no-large-animated-blur -- intentional video visual — frosted-glass blur radius tuned for launch render
    WebkitBackdropFilter: "blur(16px)",
    // oxlint-disable-next-line react-doctor/no-large-animated-blur -- intentional video visual — frosted-glass blur radius tuned for launch render
    backdropFilter: "blur(16px)",
    background: "rgba(255,255,255,0.82)",
    border: "1px solid rgba(255,255,255,0.85)",
    borderRadius: 14,
    boxShadow:
      "0 30px 70px rgba(30,40,60,0.24), inset 0 1px 0 rgba(255,255,255,0.8)",
    flex: "0 0 auto",
    opacity: cardOpacity,
    overflow: "hidden",
    transform: `translateX(${cardX}px) scale(${cardScale})`,
    width: CARD_W,
  } as const;

  const toggleThumbStyle = {
    background: WHITE,
    borderRadius: 999,
    boxShadow: "0 1px 3px rgba(20,30,50,0.16)",
    height: 28,
    left: 3,
    position: "absolute",
    top: 3,
    transform: `translateX(${activeX}px)`,
    width: SEG_W,
  } as const;

  const titleStyle = {
    color: WHITE,
    fontFamily: SANS,
    fontSize: 46,
    fontWeight: 600,
    letterSpacing: "-0.03em",
    lineHeight: 1.08,
    opacity: titleOp,
    transform: `translateY(${titleY}px)`,
  } as const;

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        flexDirection: "row",
        gap: 64,
        justifyContent: "center",
      }}
    >
      {/* Left — the generated /changelog timeline */}
      <div style={leftCardStyle}>
        {/* browser chrome */}
        <div
          style={{
            alignItems: "center",
            borderBottom: `1px solid ${CHROME_BORDER}`,
            display: "flex",
            gap: 8,
            height: 40,
            padding: "0 16px",
            position: "relative",
          }}
        >
          <TrafficLight color="#ff5f57" />
          <TrafficLight color="#febc2e" />
          <TrafficLight color="#28c840" />
          <div
            style={{
              color: "#6b7280",
              fontFamily: MONO,
              fontSize: 13,
              left: 0,
              position: "absolute",
              right: 0,
              textAlign: "center",
            }}
          >
            acme.com/changelog
          </div>
        </div>

        {/* source toggle + generated feed */}
        <div
          style={{
            alignItems: "center",
            borderBottom: `1px solid ${CHROME_BORDER}`,
            display: "flex",
            justifyContent: "center",
            opacity: toolbarOpacity,
            padding: "12px 0",
            position: "relative",
          }}
        >
          <div
            style={{
              background: "rgba(20,28,40,0.06)",
              borderRadius: 999,
              display: "flex",
              height: 34,
              padding: 3,
              position: "relative",
            }}
          >
            <div style={toggleThumbStyle} />
            <Segment
              active={!githubActive}
              icon={<PencilIcon color={githubActive ? MUTED : INK} size={13} />}
              label="Manual"
            />
            <Segment
              active={githubActive}
              icon={<GithubIcon color={githubActive ? INK : MUTED} size={14} />}
              label="GitHub Releases"
            />
          </div>
          <div style={rssLabelStyle}>
            <RssIcon color={MUTED} size={13} />
            RSS
          </div>
        </div>

        {/* the generated timeline */}
        <div style={{ padding: "24px 30px 28px" }}>
          {ENTRIES.map((entry, i) => (
            <TimelineRow
              entry={entry}
              frame={frame}
              index={i}
              isLast={i === ENTRIES.length - 1}
              key={entry.version}
            />
          ))}
        </div>
      </div>

      {/* Right — the title */}
      <div
        style={{
          flex: "0 0 auto",
          transform: `translateX(${rightX}px)`,
          width: RIGHT_W,
        }}
      >
        <div style={titleStyle}>Hand-write it, or let GitHub write it.</div>
        <div
          style={{
            color: WHITE_MUTED,
            fontFamily: SANS,
            fontSize: 19,
            lineHeight: 1.55,
            marginTop: 22,
            opacity: subOp,
          }}
        >
          Every release becomes a timeline entry and an RSS item — no page to
          build, no list to maintain.
        </div>
      </div>
    </AbsoluteFill>
  );
};
