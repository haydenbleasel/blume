import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { rafThrottle } from "../src/components/raf-throttle.ts";

/**
 * requestAnimationFrame is faked as a manually-pumped queue (the
 * copy-feedback.test.ts pattern) so the coalescing window is deterministic;
 * the original global is restored for later test files.
 */
const frames: FrameRequestCallback[] = [];
const originalRaf = globalThis.requestAnimationFrame;

const pumpFrame = (): void => {
  for (const frame of frames.splice(0)) {
    frame(0);
  }
};

beforeAll(() => {
  globalThis.requestAnimationFrame = (frame: FrameRequestCallback) => {
    frames.push(frame);
    return frames.length;
  };
});

afterAll(() => {
  globalThis.requestAnimationFrame = originalRaf;
});

describe("rafThrottle", () => {
  it("coalesces a burst of calls into one run on the next frame", () => {
    let runs = 0;
    const handler = rafThrottle(() => {
      runs += 1;
    });

    handler();
    handler();
    handler();
    expect(runs).toBe(0);

    pumpFrame();
    expect(runs).toBe(1);
  });

  it("accepts new work after the pending frame runs", () => {
    let runs = 0;
    const handler = rafThrottle(() => {
      runs += 1;
    });

    handler();
    pumpFrame();
    handler();
    pumpFrame();
    expect(runs).toBe(2);
  });
});
