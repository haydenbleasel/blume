import { afterEach, describe, expect, it, mock } from "bun:test";

import type { TrackProps } from "../src/components/layout/analytics-client.ts";

// `track()` imports the official Vercel helper at module load, so the mock must
// be registered before the dynamic import below.
const vercelTrack = mock((_event: string, _props: TrackProps) => {
  // no-op
});
mock.module("@vercel/analytics", () => ({ track: vercelTrack }));

const { track } = await import("../src/components/layout/analytics-client.ts");

type Fn = ReturnType<typeof mock>;

interface WindowStub {
  __blumeGtmLayer?: { push: Fn };
  _satellite?: { track?: Fn };
  amplitude?: { track?: Fn };
  analytics?: { track?: Fn };
  blumeLayer?: { push: Fn };
  clarity?: Fn;
  dataLayer?: { push: Fn };
  databuddy?: { track?: Fn };
  dispatchEvent: (event: CustomEvent) => boolean;
  fathom?: { trackEvent?: Fn };
  gtag?: Fn;
  heap?: { track?: Fn };
  hj?: Fn;
  htevents?: { track?: Fn };
  LogRocket?: { track?: Fn };
  mixpanel?: { track?: Fn };
  pirsch?: Fn;
  plausible?: Fn;
  posthog?: { capture?: Fn };
}

const noop = () => {
  // no-op
};

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
    const fns = {
      LogRocket: mock(noop),
      _satellite: mock(noop),
      amplitude: mock(noop),
      analytics: mock(noop),
      capture: mock(noop),
      clarity: mock(noop),
      dataLayer: mock(noop),
      databuddy: mock(noop),
      fathom: mock(noop),
      gtag: mock(noop),
      heap: mock(noop),
      hj: mock(noop),
      htevents: mock(noop),
      mixpanel: mock(noop),
      pirsch: mock(noop),
      plausible: mock(noop),
    };
    setWindow({
      LogRocket: { track: fns.LogRocket },
      _satellite: { track: fns._satellite },
      amplitude: { track: fns.amplitude },
      analytics: { track: fns.analytics },
      clarity: fns.clarity,
      dataLayer: { push: fns.dataLayer },
      databuddy: { track: fns.databuddy },
      dispatchEvent: (event) => {
        dispatched.push(event);
        return true;
      },
      fathom: { trackEvent: fns.fathom },
      gtag: fns.gtag,
      heap: { track: fns.heap },
      hj: fns.hj,
      htevents: { track: fns.htevents },
      mixpanel: { track: fns.mixpanel },
      pirsch: fns.pirsch,
      plausible: fns.plausible,
      posthog: { capture: fns.capture },
    });

    const props = { helpful: "yes", path: "/docs/intro", title: "Intro" };
    track("feedback", props);

    expect(vercelTrack).toHaveBeenCalledWith("feedback", props);
    // Queued SDK objects take the name and the properties.
    for (const sdk of [
      fns.capture,
      fns.mixpanel,
      fns.heap,
      fns.analytics,
      fns.htevents,
      fns.amplitude,
      fns.LogRocket,
      fns._satellite,
    ]) {
      expect(sdk).toHaveBeenCalledWith("feedback", props);
    }
    expect(fns.gtag).toHaveBeenCalledWith("event", "feedback", props);
    expect(fns.dataLayer).toHaveBeenCalledWith({ ...props, event: "feedback" });
    expect(fns.plausible).toHaveBeenCalledWith("feedback", { props });
    expect(fns.databuddy).toHaveBeenCalledWith("feedback", props);
    expect(fns.fathom).toHaveBeenCalledWith("feedback");
    expect(fns.pirsch).toHaveBeenCalledWith("feedback", { meta: props });
    expect(fns.clarity).toHaveBeenCalledWith("event", "feedback");
    expect(fns.hj).toHaveBeenCalledWith("event", "feedback");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe("blume:track");
    expect(dispatched[0]?.detail).toEqual({ event: "feedback", props });
  });

  it("pushes into the Tag Manager data layer the container snippet named", () => {
    // `googleTagManager({ dataLayer: "blumeLayer" })` makes the container read
    // `window.blumeLayer`; `window.dataLayer` belongs to the Google tag.
    const layerPush = mock(noop);
    const defaultPush = mock(noop);
    const gtag = mock(noop);
    const blumeLayer = { push: layerPush };
    setWindow({
      __blumeGtmLayer: blumeLayer,
      blumeLayer,
      dataLayer: { push: defaultPush },
      dispatchEvent: () => true,
      gtag,
    });

    const props = { helpful: "yes", path: "/x" };
    track("feedback", props);

    expect(layerPush).toHaveBeenCalledWith({ ...props, event: "feedback" });
    expect(defaultPush).not.toHaveBeenCalled();
    expect(gtag).toHaveBeenCalledWith("event", "feedback", props);
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

  it("isolates a provider that throws from the rest and the caller", () => {
    // A consent shim that stubs `gtag` with a raise must neither starve
    // Plausible and the custom event nor surface in the feedback handler.
    const dispatched: CustomEvent[] = [];
    const plausible = mock(() => {
      // no-op
    });
    setWindow({
      dispatchEvent: (event) => {
        dispatched.push(event);
        return true;
      },
      gtag: mock(() => {
        throw new Error("consent blocked");
      }),
      plausible,
    });

    expect(() => track("feedback", { helpful: "yes" })).not.toThrow();
    expect(plausible).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
  });

  it("keeps local properties off the providers and on the custom event", () => {
    const dispatched: CustomEvent[] = [];
    const capture = mock(() => {
      // no-op
    });
    setWindow({
      dispatchEvent: (event) => {
        dispatched.push(event);
        return true;
      },
      posthog: { capture },
    });

    track("ask", { path: "/x" }, { question: "sk-live-… returns 401?" });

    expect(vercelTrack).toHaveBeenCalledWith("ask", { path: "/x" });
    expect(capture).toHaveBeenCalledWith("ask", { path: "/x" });
    expect(dispatched[0]?.detail).toEqual({
      event: "ask",
      props: { path: "/x", question: "sk-live-… returns 401?" },
    });
  });
});
