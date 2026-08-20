/**
 * Send a custom analytics event to every analytics platform configured in
 * `blume.config.ts`. Mirrors the providers wired by `Analytics.astro`: Vercel
 * Web Analytics and PostHog are first-class; any other provider added through
 * `analytics.scripts` is reached via best-effort global detection or the
 * `blume:track` CustomEvent, which fires unconditionally so a project can bridge
 * the event to anything. Every call no-ops cleanly when a provider isn't present
 * — for example during `blume dev`, where `Analytics.astro` injects nothing.
 */
import { track as vercelTrack } from "@vercel/analytics";

/** Flat, serializable event properties. */
export type TrackProps = Record<string, boolean | number | string>;

interface AnalyticsWindow {
  gtag?: (command: "event", event: string, props?: TrackProps) => void;
  plausible?: (event: string, options?: { props?: TrackProps }) => void;
  posthog?: { capture?: (event: string, props?: TrackProps) => void };
}

export const track = (event: string, props: TrackProps): void => {
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
  vercelTrack(event, props);
  // PostHog — the injected array.js stub queues calls until the lib loads.
  w.posthog?.capture?.(event, props);
  // Popular providers wired through `analytics.scripts` (GA4/GTM, Plausible).
  w.gtag?.("event", event, props);
  w.plausible?.(event, { props });
  // Universal hook for any other integration.
  w.dispatchEvent(new CustomEvent("blume:track", { detail: { event, props } }));
};
