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

/**
 * One thing `Analytics.astro` renders, in the adapters' declared order. Vercel
 * is the one adapter that renders a component rather than a tag: the official
 * component injects the first-party script and resolves the deployment's base
 * path itself, so it travels as its props.
 */
export type HeadNode =
  | (HeadScript & { type: "script" })
  | { props: VercelOptions; type: "vercel" };

/**
 * Map the configured adapters to what `Analytics.astro` renders, one node per
 * adapter in declared order. Each adapter module owns its snippet; this is the
 * one place that branches on `kind`. A second `vercel()` is dropped — two
 * copies of the component would count every pageview twice — so the first one
 * keeps its position.
 */
export const analyticsHead = (adapters: AnalyticsAdapter[]): HeadNode[] => {
  const nodes: HeadNode[] = [];
  let hasVercel = false;
  for (const adapter of adapters) {
    if (adapter.kind === "vercel") {
      if (!hasVercel) {
        hasVercel = true;
        nodes.push({ props: adapter.options, type: "vercel" });
      }
    } else if (adapter.kind === "cloudflare") {
      nodes.push({ ...cloudflareHead(adapter.options), type: "script" });
    } else if (adapter.kind === "posthog") {
      nodes.push({ ...posthogHead(adapter.options), type: "script" });
    } else {
      nodes.push({ ...scriptHead(adapter.options), type: "script" });
    }
  }
  return nodes;
};
