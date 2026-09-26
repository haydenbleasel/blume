import { describe, expect, it } from "bun:test";

import {
  followScroll,
  formatClock,
  isInView,
  NARRATION_SPEEDS,
  parseSpeed,
  pickVoice,
  progressAt,
  progressLabel,
  progressTotal,
  seekKeyTarget,
  spokenFraction,
  stepAtProgress,
  stepsFromManifest,
  stepsFromSegments,
} from "../src/narration/player.ts";
import type { NarrationStep } from "../src/narration/player.ts";

/**
 * Tests for the narration player's decisions (`src/narration/player.ts`),
 * which `NarrationPlayer.astro` consults while it plays.
 */

describe(stepsFromSegments, () => {
  it("speaks every segment, with cues unhighlighted", () => {
    expect(
      stepsFromSegments([
        { block: null, end: 0, start: 0, text: "Note." },
        { block: 2, end: 5, start: 0, text: "Hello" },
      ])
    ).toEqual([
      { audio: null, block: -1, end: 0, start: 0, text: "Note." },
      { audio: null, block: 2, end: 5, start: 0, text: "Hello" },
    ]);
  });
});

describe(stepsFromManifest, () => {
  it("maps clips onto the live page's blocks", () => {
    const steps = stepsFromManifest(
      {
        blocks: ["Hello there. Bye.", "Unaligned."],
        segments: [
          { audio: "cue.mp3", text: "Note." },
          { audio: "a.mp3", block: 0, end: 12, start: 0 },
          { audio: "b.mp3", block: 1, end: 10, start: 0 },
          { audio: "c.mp3", block: 7, end: 3, start: 0 },
        ],
        version: 1,
      },
      [4, -1],
      "/base/blume-narration/audio/"
    );
    expect(steps).toEqual([
      {
        audio: "/base/blume-narration/audio/cue.mp3",
        block: -1,
        end: 0,
        start: 0,
        text: "Note.",
      },
      {
        audio: "/base/blume-narration/audio/a.mp3",
        block: 4,
        end: 12,
        start: 0,
        text: "Hello there.",
      },
      {
        audio: "/base/blume-narration/audio/b.mp3",
        block: -1,
        end: 10,
        start: 0,
        text: "Unaligned.",
      },
      {
        audio: "/base/blume-narration/audio/c.mp3",
        block: -1,
        end: 3,
        start: 0,
        text: "",
      },
    ]);
  });
});

describe(parseSpeed, () => {
  it("returns an offered speed, else 1", () => {
    expect(parseSpeed("1.5")).toBe(1.5);
    expect(parseSpeed("0.8")).toBe(0.8);
    expect(parseSpeed("3")).toBe(1);
    expect(parseSpeed(null)).toBe(1);
    expect(NARRATION_SPEEDS).toContain(2);
  });
});

/** A voice as `speechSynthesis.getVoices()` describes one. */
const voice = (
  lang: string,
  extra: { default?: boolean; local?: boolean } = {}
) => ({
  default: extra.default ?? false,
  lang,
  localService: extra.local ?? false,
});

describe(pickVoice, () => {
  it("prefers the exact locale, then the default, then an on-device voice", () => {
    const fr = voice("fr-FR");
    const us = voice("en-US");
    const usDefault = voice("en-US", { default: true });
    expect(pickVoice([fr, us, usDefault], "en-US")).toBe(usDefault);
    const usLocal = voice("en_US", { local: true });
    expect(pickVoice([fr, us, usLocal], "en-us")).toBe(usLocal);
    expect(pickVoice([fr, us], "en-US")).toBe(us);
  });

  it("falls back to any voice for the language", () => {
    const gb = voice("en-GB");
    expect(pickVoice([voice("de-DE"), gb], "en")).toBe(gb);
  });

  it("is null when no voice reads the language", () => {
    expect(pickVoice([voice("de-DE")], "ja")).toBeNull();
    expect(pickVoice([], "en")).toBeNull();
  });
});

describe(followScroll, () => {
  it("leaves a comfortably visible sentence alone", () => {
    expect(followScroll({ bottom: 400, top: 380 }, 120, 800)).toBe(0);
  });

  it("scrolls a sentence below or behind the player to a quarter down", () => {
    // Target line: 120 + (800 - 120) * 0.25 = 290.
    expect(followScroll({ bottom: 900, top: 880 }, 120, 800)).toBe(590);
    expect(followScroll({ bottom: 110, top: 90 }, 120, 800)).toBe(-200);
  });
});

describe(isInView, () => {
  it("is true while any of the sentence shows below the inset", () => {
    expect(isInView({ bottom: 130, top: 100 }, 120, 800)).toBe(true);
    expect(isInView({ bottom: 110, top: 90 }, 120, 800)).toBe(false);
    expect(isInView({ bottom: 900, top: 820 }, 120, 800)).toBe(false);
  });
});

describe(formatClock, () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65.4)).toBe("1:05");
    expect(formatClock(-3)).toBe("0:00");
  });
});

const step = (text: string): NarrationStep => ({
  audio: null,
  block: 0,
  end: text.length,
  start: 0,
  text,
});

describe("progress", () => {
  const steps = [step("x".repeat(100)), step("x".repeat(200))];

  it("measures playback in characters, through the sentence being read", () => {
    expect(progressTotal(steps)).toBe(300);
    expect(progressAt(steps, 0, 0)).toBe(0);
    expect(progressAt(steps, 1, 0.5)).toBe(200);
    // The fraction is clamped, and a step past the end adds nothing.
    expect(progressAt(steps, 1, 2)).toBe(300);
    expect(progressAt(steps, 0, -1)).toBe(0);
    expect(progressAt(steps, 2, 0.5)).toBe(300);
    expect(progressAt(steps, -1, 0.5)).toBe(0);
  });

  it("finds the step being read at a position", () => {
    expect(stepAtProgress(steps, 0)).toBe(0);
    expect(stepAtProgress(steps, 99)).toBe(0);
    expect(stepAtProgress(steps, 100)).toBe(1);
    expect(stepAtProgress(steps, 300)).toBe(1);
    expect(stepAtProgress([], 10)).toBe(0);
  });

  it("estimates how far a browser voice is through its sentence", () => {
    // English reads at 15 characters a second.
    expect(spokenFraction(150, 5000, 1, "en")).toBe(0.5);
    expect(spokenFraction(150, 5000, 2, "en")).toBe(1);
    expect(spokenFraction(150, 60_000, 1, "en")).toBe(1);
    expect(spokenFraction(0, 0, 1, "en")).toBe(1);
  });

  it("estimates time read and total at the speed", () => {
    const even = [step("x".repeat(150)), step("x".repeat(150))];
    expect(progressLabel(even, 0, 1, "en")).toBe("0:00 / 0:20");
    expect(progressLabel(even, 150, 1, "en")).toBe("0:10 / 0:20");
    expect(progressLabel(even, 225, 1, "en")).toBe("0:15 / 0:20");
    expect(progressLabel(even, 150, 2, "en")).toBe("0:05 / 0:10");
  });
});

describe(seekKeyTarget, () => {
  it("moves a sentence per arrow key, clamped to the page", () => {
    expect(seekKeyTarget("ArrowRight", 3, 10, false)).toBe(4);
    expect(seekKeyTarget("ArrowUp", 3, 10, false)).toBe(4);
    expect(seekKeyTarget("ArrowLeft", 3, 10, false)).toBe(2);
    expect(seekKeyTarget("ArrowDown", 3, 10, false)).toBe(2);
    expect(seekKeyTarget("ArrowLeft", 0, 10, false)).toBe(0);
    expect(seekKeyTarget("ArrowRight", 9, 10, false)).toBe(9);
  });

  it("flips the horizontal arrows on right-to-left pages", () => {
    expect(seekKeyTarget("ArrowLeft", 3, 10, true)).toBe(4);
    expect(seekKeyTarget("ArrowRight", 3, 10, true)).toBe(2);
  });

  it("jumps to either end, and leaves other keys to the bar", () => {
    expect(seekKeyTarget("Home", 3, 10, false)).toBe(0);
    expect(seekKeyTarget("End", 3, 10, false)).toBe(9);
    expect(seekKeyTarget("PageUp", 3, 10, false)).toBeNull();
    expect(seekKeyTarget("End", 0, 0, false)).toBe(0);
  });
});
