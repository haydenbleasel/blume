import { cloudflareHead } from "./cloudflare.ts";
import { posthogHead } from "./posthog.ts";
import type { AnalyticsAdapter } from "./schema.ts";
import { scriptHead } from "./script.ts";
import type { VercelOptions } from "./vercel.ts";

/** One `<script>` tag an adapter emits into `<head>`. */
export interface HeadScript {
  /**
   * Attributes on the tag, including `src` for an external script. `true`
   * renders a bare boolean attribute (`async`, `defer`).
   */
  attributes: Record<string, string | boolean>;
  /** Inline body, or `null` for an external script. */
  content: string | null;
}

/** Everything the configured adapters emit into `<head>`. */
export interface AnalyticsHead {
  /** Script tags, in the adapters' declared order. */
  scripts: HeadScript[];
  /**
   * Props for the official `@vercel/analytics/astro` component, or `null` when
   * no `vercel()` adapter is listed. Vercel is the one adapter that renders a
   * component rather than a tag: the component injects the first-party script
   * and resolves the deployment's base path itself.
   */
  vercel: VercelOptions | null;
}

/**
 * Map the configured adapters to what `Analytics.astro` renders. Each adapter
 * module owns its snippet; this is the one place that branches on `kind`.
 */
export const analyticsHead = (adapters: AnalyticsAdapter[]): AnalyticsHead => {
  const scripts: HeadScript[] = [];
  let vercel: VercelOptions | null = null;
  for (const adapter of adapters) {
    if (adapter.kind === "vercel") {
      vercel ??= adapter.options;
    } else if (adapter.kind === "cloudflare") {
      scripts.push(cloudflareHead(adapter.options));
    } else if (adapter.kind === "posthog") {
      scripts.push(posthogHead(adapter.options));
    } else {
      scripts.push(scriptHead(adapter.options));
    }
  }
  return { scripts, vercel };
};
