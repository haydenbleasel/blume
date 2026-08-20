import { afterEach, describe, expect, it, mock } from "bun:test";

import type { TrackProps } from "../src/components/layout/analytics-client.ts";

// `track()` imports the official Vercel helper at module load, so the mock must
// be registered before the dynamic import below.
const vercelTrack = mock((_event: string, _props: TrackProps) => {
  // no-op
});
mock.module("@vercel/analytics", () => ({ track: vercelTrack }));

const { track } = await import("../src/components/layout/analytics-client.ts");

interface WindowStub {
  dispatchEvent: (event: CustomEvent) => boolean;
  gtag?: ReturnType<typeof mock>;
  plausible?: ReturnType<typeof mock>;
  posthog?: { capture?: ReturnType<typeof mock> };
}

const setWindow = (stub: WindowStub): void => {
  // SAFETY: tests run without a DOM, so `globalThis.window` is free for the
  // stub, which carries just the members `track` reads.
  (globalThis as { window?: WindowStub }).window = stub;
};

afterEach(() => {
  // Reset to `undefined` (not null): the code under test guards on
  // `typeof window === "undefined"`, so null would not restore SSR state.
  // SAFETY: same globalThis escape hatch as `setWindow`, restoring SSR state.
  // oxlint-disable-next-line sonarjs/no-undefined-assignment
  (globalThis as { window?: WindowStub }).window = undefined;
  vercelTrack.mockClear();
});

describe("track", () => {
  it("no-ops when window is undefined (import/SSR safe)", () => {
    expect(() =>
      track("feedback", { helpful: "yes", path: "/x" })
    ).not.toThrow();
    expect(vercelTrack).not.toHaveBeenCalled();
  });

  it("fans the event out to every configured provider", () => {
    const dispatched: CustomEvent[] = [];
    const capture = mock(() => {
      // no-op
    });
    const gtag = mock(() => {
      // no-op
    });
    const plausible = mock(() => {
      // no-op
    });
    setWindow({
      dispatchEvent: (event) => {
        dispatched.push(event);
        return true;
      },
      gtag,
      plausible,
      posthog: { capture },
    });

    const props = { helpful: "yes", path: "/docs/intro", title: "Intro" };
    track("feedback", props);

    expect(vercelTrack).toHaveBeenCalledWith("feedback", props);
    expect(capture).toHaveBeenCalledWith("feedback", props);
    expect(gtag).toHaveBeenCalledWith("event", "feedback", props);
    expect(plausible).toHaveBeenCalledWith("feedback", { props });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe("blume:track");
    expect(dispatched[0]?.detail).toEqual({ event: "feedback", props });
  });

  it("still fires Vercel and the custom event when other providers are absent", () => {
    const dispatched: CustomEvent[] = [];
    setWindow({
      dispatchEvent: (event) => {
        dispatched.push(event);
        return true;
      },
    });

    expect(() =>
      track("feedback", { helpful: "no", path: "/x" })
    ).not.toThrow();
    expect(vercelTrack).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
  });
});
