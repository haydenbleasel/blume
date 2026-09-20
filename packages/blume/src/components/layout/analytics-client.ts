/**
 * Send a custom analytics event to every analytics platform configured in
 * `blume.config.ts`. Mirrors the providers wired by `Analytics.astro`: Vercel
 * Web Analytics and PostHog are first-class (Cloudflare Web Analytics is too,
 * but has no custom-event API to forward to); any other provider added through
 * `analytics.scripts` is reached via best-effort global detection or the
 * `blume:track` CustomEvent, which fires unconditionally so a project can bridge
 * the event to anything. Every call no-ops cleanly when a provider isn't present
 * — for example during `blume dev`, where `Analytics.astro` injects nothing —
 * and a provider that throws (a consent shim that stubs `gtag` with a raise, a
 * broken snippet) is isolated so it neither starves the providers after it nor
 * surfaces in the feature that reported the event.
 */
import { track as vercelTrack } from "@vercel/analytics";

/** Flat, serializable event properties. */
export type TrackProps = Record<string, boolean | number | string>;

interface AnalyticsWindow {
  gtag?: (command: "event", event: string, props?: TrackProps) => void;
  plausible?: (event: string, options?: { props?: TrackProps }) => void;
  posthog?: { capture?: (event: string, props?: TrackProps) => void };
}

/** Run one provider call; its failure must not reach the others or the caller. */
const attempt = (send: () => void): void => {
  try {
    send();
  } catch {
    // Analytics never breaks the feature that reported the event.
  }
};

/**
 * @param event The event name.
 * @param props Properties every provider receives.
 * @param local Properties only the `blume:track` CustomEvent carries — free
 *   text a site may bridge to a provider on its own terms, but that must not
 *   reach third parties unasked (a reader's Ask AI question, for instance).
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
  // PostHog — the injected array.js stub queues calls until the lib loads.
  attempt(() => w.posthog?.capture?.(event, props));
  // Popular providers wired through `analytics.scripts` (GA4/GTM, Plausible).
  attempt(() => w.gtag?.("event", event, props));
  attempt(() => w.plausible?.(event, { props }));
  // Universal hook for any other integration.
  attempt(() =>
    w.dispatchEvent(
      new CustomEvent("blume:track", {
        detail: { event, props: { ...props, ...local } },
      })
    )
  );
};
