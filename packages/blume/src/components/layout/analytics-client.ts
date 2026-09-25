/**
 * Send a custom analytics event to every analytics platform configured in
 * `blume.config.ts`. Mirrors the adapters `Analytics.astro` wires
 * (`src/analytics/*`): each one with a custom-event API is called through the
 * global its snippet defines (Cloudflare and Clearbit have none to forward
 * to), and the `blume:track` CustomEvent fires unconditionally so a project
 * can bridge the event to anything else — a `script()` adapter, say. Every
 * call no-ops cleanly when a provider isn't present — for example during
 * `blume dev`, where `Analytics.astro` injects nothing — and a provider that
 * throws (a consent shim that stubs `gtag` with a raise, a broken snippet) is
 * isolated so it neither starves the providers after it nor surfaces in the
 * feature that reported the event.
 */
import { track as vercelTrack } from "@vercel/analytics";

/** Flat, serializable event properties. */
export type TrackProps = Record<string, boolean | number | string>;

/** A Tag Manager data layer: a queue the container drains. */
interface DataLayer {
  push: (entry: TrackProps & { event: string }) => number;
}

interface AnalyticsWindow {
  /** The data layer a `googleTagManager()` snippet's container reads. */
  __blumeGtmLayer?: DataLayer;
  _satellite?: { track?: (event: string, props?: TrackProps) => void };
  amplitude?: { track?: (event: string, props?: TrackProps) => void };
  analytics?: { track?: (event: string, props?: TrackProps) => void };
  clarity?: (command: "event", event: string) => void;
  dataLayer?: DataLayer;
  databuddy?: { track?: (event: string, props?: TrackProps) => void };
  fathom?: { trackEvent?: (event: string) => void };
  gtag?: (command: "event", event: string, props?: TrackProps) => void;
  heap?: { track?: (event: string, props?: TrackProps) => void };
  hj?: (command: "event", event: string) => void;
  htevents?: { track?: (event: string, props?: TrackProps) => void };
  LogRocket?: { track?: (event: string, props?: TrackProps) => void };
  mixpanel?: { track?: (event: string, props?: TrackProps) => void };
  pirsch?: (event: string, options?: { meta?: TrackProps }) => void;
  plausible?: (event: string, options?: { props?: TrackProps }) => void;
  posthog?: { capture?: (event: string, props?: TrackProps) => void };
  stonks?: {
    event?: (event: string, props?: Record<string, string>) => void;
  };
}

/** Run one provider call; its failure must not reach the others or the caller. */
const attempt = (send: () => void): void => {
  try {
    send();
  } catch {
    // Analytics never breaks the feature that reported the event.
  }
};

// The SDKs whose loader stub queues calls until the library lands, so the
// method is there to call from the first paint on.
const trackQueued = (
  w: AnalyticsWindow,
  event: string,
  props: TrackProps
): void => {
  attempt(() => w.posthog?.capture?.(event, props));
  attempt(() => w.mixpanel?.track?.(event, props));
  attempt(() => w.heap?.track?.(event, props));
  attempt(() => w.analytics?.track?.(event, props));
  attempt(() => w.htevents?.track?.(event, props));
  attempt(() => w.amplitude?.track?.(event, props));
  attempt(() => w.LogRocket?.track?.(event, props));
  attempt(() => w._satellite?.track?.(event, props));
};

// The providers reached through a global function or a data layer rather
// than a queued SDK object.
const trackGlobals = (
  w: AnalyticsWindow,
  event: string,
  props: TrackProps
): void => {
  // Google: `gtag('event')` for the Google tag, and a plain `{ event }` push
  // for a Tag Manager custom-event trigger, into the container's own data
  // layer. Each reads only its own shape, so a site with both configured
  // still sees the event once per product.
  attempt(() => w.gtag?.("event", event, props));
  attempt(() => (w.__blumeGtmLayer ?? w.dataLayer)?.push({ ...props, event }));
  // Privacy-first counters take a name, some with properties.
  attempt(() => w.plausible?.(event, { props }));
  attempt(() => w.databuddy?.track?.(event, props));
  attempt(() => w.fathom?.trackEvent?.(event));
  // OneDollarStats only takes string property values.
  attempt(() =>
    w.stonks?.event?.(
      event,
      Object.fromEntries(
        Object.entries(props).map(([key, value]) => [key, String(value)])
      )
    )
  );
  // Pirsch stringifies `meta` values in place, so it gets its own copy and
  // the `blume:track` listeners still see the original types.
  attempt(() => w.pirsch?.(event, { meta: { ...props } }));
  // Behavior tools take a bare name.
  attempt(() => w.clarity?.("event", event));
  attempt(() => w.hj?.("event", event));
};

/**
 * @param event The event name.
 * @param props Properties every provider receives.
 * @param local Properties only the `blume:track` CustomEvent carries — free
 *   text a site may bridge to a provider on its own terms, but that must not
 *   reach third parties unasked (a reader's question to the assistant, for instance).
 */
export const track = (
  event: string,
  props: TrackProps,
  local: TrackProps = {}
): void => {
  // Read through `globalThis` so an SSR/import-time call sees `undefined`
  // instead of a bare-identifier ReferenceError.
  const browserWindow = globalThis.window;
  if (browserWindow === undefined) {
    return;
  }
  // SAFETY: AnalyticsWindow only adds optional provider globals, so any window
  // satisfies the intersection; each provider is feature-checked before use.
  const w = browserWindow as typeof browserWindow & AnalyticsWindow;

  // Vercel Web Analytics — self-gates to a no-op until `window.va` is set up.
  attempt(() => vercelTrack(event, props));
  trackQueued(w, event, props);
  trackGlobals(w, event, props);
  // Universal hook for any other integration.
  attempt(() =>
    w.dispatchEvent(
      new CustomEvent("blume:track", {
        detail: { event, props: { ...props, ...local } },
      })
    )
  );
};
