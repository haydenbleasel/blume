/**
 * The narration player's decisions, kept apart from the DOM so they can be
 * tested: which clip or sentence comes next, which browser voice reads a
 * language, how far to scroll to keep the sentence in view, and what the
 * progress readout says. `NarrationPlayer.astro` owns the elements, the audio,
 * and the listeners, and asks these helpers what to do.
 */

import { narrationCharsPerSecond } from "./script.ts";
import type { NarrationManifest, NarrationSegment } from "./script.ts";

/** The playback speeds the player offers. */
export const NARRATION_SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * One thing the player reads: its text, the page block and range to
 * highlight (`block: -1` when there is none, like a cue), and the clip to play
 * (`null` to speak `text` with a browser voice).
 */
export interface NarrationStep {
  audio: string | null;
  block: number;
  end: number;
  start: number;
  text: string;
}

/**
 * The steps for browser voices: every segment the page's own extract yielded,
 * spoken as text.
 */
export const stepsFromSegments = (
  segments: readonly NarrationSegment[]
): NarrationStep[] =>
  segments.map((segment) => ({
    audio: null,
    block: segment.block ?? -1,
    end: segment.end,
    start: segment.start,
    text: segment.text,
  }));

/**
 * The steps for generated audio: one per manifest clip, with its sentence
 * mapped onto the live page through `aligned` (see `alignBlocks`). A clip whose
 * block didn't align plays without a highlight. `text` is kept so a clip that
 * fails to load can still be spoken by a browser voice.
 */
export const stepsFromManifest = (
  manifest: NarrationManifest,
  aligned: readonly number[],
  audioBase: string
): NarrationStep[] =>
  manifest.segments.map((segment) => {
    const audio = `${audioBase}${segment.audio}`;
    if ("text" in segment) {
      return { audio, block: -1, end: 0, start: 0, text: segment.text };
    }
    const text = manifest.blocks[segment.block] ?? "";
    return {
      audio,
      block: aligned[segment.block] ?? -1,
      end: segment.end,
      start: segment.start,
      text: text.slice(segment.start, segment.end),
    };
  });

/** A speed read back from storage, or `1` when it isn't one the player offers. */
export const parseSpeed = (value: string | null): number => {
  const speed = Number(value);
  return NARRATION_SPEEDS.find((offered) => offered === speed) ?? 1;
};

/** The parts of a `SpeechSynthesisVoice` the choice depends on. */
export interface VoiceChoice {
  default: boolean;
  lang: string;
  localService: boolean;
}

const normalizeLang = (lang: string): string =>
  lang.toLowerCase().replaceAll("_", "-");

const primaryTag = (lang: string): string =>
  normalizeLang(lang).split("-")[0] ?? "";

/**
 * The browser voice that reads `lang`: among voices for the exact locale
 * (else any voice for the language), the browser's default, else an
 * on-device voice, else the first. `null` when the browser has no voice for
 * the language, in which case the player stays hidden rather than reading the
 * page in the wrong accent.
 */
export const pickVoice = <Voice extends VoiceChoice>(
  voices: readonly Voice[],
  lang: string
): Voice | null => {
  const wanted = normalizeLang(lang);
  const exact = voices.filter((voice) => normalizeLang(voice.lang) === wanted);
  const pool =
    exact.length > 0
      ? exact
      : voices.filter((voice) => primaryTag(voice.lang) === primaryTag(wanted));
  return (
    pool.find((voice) => voice.default) ??
    pool.find((voice) => voice.localService) ??
    pool[0] ??
    null
  );
};

/** A sentence's box, as `Range.getBoundingClientRect()` reports it. */
export interface FollowRect {
  bottom: number;
  top: number;
}

/**
 * How far to scroll so the sentence being read sits a quarter of the way down
 * the visible area below `inset` (the sticky header and player), or `0` when it
 * is already comfortably in view.
 */
export const followScroll = (
  rect: FollowRect,
  inset: number,
  viewport: number
): number => {
  const margin = 24;
  if (rect.top >= inset + margin && rect.bottom <= viewport - margin) {
    return 0;
  }
  const target = inset + (viewport - inset) * 0.25;
  return Math.round(rect.top - target);
};

/** Whether any of the sentence is visible below `inset`. */
export const isInView = (
  rect: FollowRect,
  inset: number,
  viewport: number
): boolean => rect.bottom > inset && rect.top < viewport;

/** `m:ss`, for the progress readout. */
export const formatClock = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * How much of the page `steps` read, in characters. Progress is measured in
 * characters rather than steps, so a long sentence moves the seek bar and the
 * readout further than a short one.
 */
export const progressTotal = (steps: readonly NarrationStep[]): number =>
  steps.reduce((total, step) => total + step.text.length, 0);

/**
 * Where playback is, in characters: every step before `index` in full, plus
 * `fraction` (0 to 1) of the step being read.
 */
export const progressAt = (
  steps: readonly NarrationStep[],
  index: number,
  fraction: number
): number => {
  const current = steps[index]?.text.length ?? 0;
  return (
    progressTotal(steps.slice(0, Math.max(0, index))) +
    current * Math.min(1, Math.max(0, fraction))
  );
};

/** The step being read at `position` characters (the last step past the end). */
export const stepAtProgress = (
  steps: readonly NarrationStep[],
  position: number
): number => {
  let end = 0;
  for (const [index, step] of steps.entries()) {
    end += step.text.length;
    if (position < end) {
      return index;
    }
  }
  return Math.max(0, steps.length - 1);
};

/**
 * How far a browser voice is through `length` characters, `elapsedMs` after it
 * started them at `speed`. An estimate from the reading rate, since a voice
 * reports no duration; it holds at the end until the next sentence starts.
 */
export const spokenFraction = (
  length: number,
  elapsedMs: number,
  speed: number,
  lang: string
): number =>
  length > 0
    ? Math.min(
        1,
        ((elapsedMs / 1000) * narrationCharsPerSecond(lang) * speed) / length
      )
    : 1;

/**
 * The step a key on the seek bar moves to: one sentence per arrow key (the
 * horizontal ones flipped for right-to-left pages), or the first or last with
 * Home and End. `null` for any other key, which the bar handles itself.
 */
export const seekKeyTarget = (
  key: string,
  index: number,
  count: number,
  rtl: boolean
): number | null => {
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const back = rtl ? "ArrowRight" : "ArrowLeft";
  const targets = new Map([
    ["ArrowDown", index - 1],
    ["ArrowUp", index + 1],
    ["End", count - 1],
    ["Home", 0],
    [back, index - 1],
    [forward, index + 1],
  ]);
  const target = targets.get(key);
  return target === undefined
    ? null
    : Math.min(Math.max(0, count - 1), Math.max(0, target));
};

/**
 * The progress readout at `position` characters: the estimated time read so
 * far and in total at `speed`, as `m:ss / m:ss`. An estimate from character
 * counts, since a browser voice reports no duration and a clip's is only
 * known once loaded.
 */
export const progressLabel = (
  steps: readonly NarrationStep[],
  position: number,
  speed: number,
  lang: string
): string => {
  const rate = narrationCharsPerSecond(lang) * speed;
  return `${formatClock(position / rate)} / ${formatClock(progressTotal(steps) / rate)}`;
};
