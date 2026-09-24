import { adobeHead } from "./adobe.ts";
import { amplitudeHead } from "./amplitude.ts";
import { clarityHead } from "./clarity.ts";
import { clearbitHead } from "./clearbit.ts";
import { cloudflareHead } from "./cloudflare.ts";
import { databuddyHead } from "./databuddy.ts";
import { fathomHead } from "./fathom.ts";
import { googleAnalyticsHead } from "./google-analytics.ts";
import { googleTagManagerHead } from "./google-tag-manager.ts";
import { heapHead } from "./heap.ts";
import { hightouchHead } from "./hightouch.ts";
import { hotjarHead } from "./hotjar.ts";
import { logrocketHead } from "./logrocket.ts";
import { mixpanelHead } from "./mixpanel.ts";
import { pirschHead } from "./pirsch.ts";
import { plausibleHead } from "./plausible.ts";
import { posthogHead } from "./posthog.ts";
import type { AnalyticsAdapter } from "./schema.ts";
import { scriptHead } from "./script.ts";
import { segmentHead } from "./segment.ts";
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
 * The tags one adapter emits. Each adapter module owns its snippet; this is
 * the one place that branches on `kind`. A provider whose install snippet is
 * two tags (an SDK plus its init call) emits two.
 */
const adapterScripts = (
  adapter: Exclude<AnalyticsAdapter, { kind: "vercel" }>
): HeadScript[] => {
  switch (adapter.kind) {
    case "adobe": {
      return adobeHead(adapter.options);
    }
    case "amplitude": {
      return amplitudeHead(adapter.options);
    }
    case "clarity": {
      return clarityHead(adapter.options);
    }
    case "clearbit": {
      return clearbitHead(adapter.options);
    }
    case "cloudflare": {
      return cloudflareHead(adapter.options);
    }
    case "databuddy": {
      return databuddyHead(adapter.options);
    }
    case "fathom": {
      return fathomHead(adapter.options);
    }
    case "google-analytics": {
      return googleAnalyticsHead(adapter.options);
    }
    case "google-tag-manager": {
      return googleTagManagerHead(adapter.options);
    }
    case "heap": {
      return heapHead(adapter.options);
    }
    case "hightouch": {
      return hightouchHead(adapter.options);
    }
    case "hotjar": {
      return hotjarHead(adapter.options);
    }
    case "logrocket": {
      return logrocketHead(adapter.options);
    }
    case "mixpanel": {
      return mixpanelHead(adapter.options);
    }
    case "pirsch": {
      return pirschHead(adapter.options);
    }
    case "plausible": {
      return plausibleHead(adapter.options);
    }
    case "posthog": {
      return posthogHead(adapter.options);
    }
    case "segment": {
      return segmentHead(adapter.options);
    }
    default: {
      return scriptHead(adapter.options);
    }
  }
};

/**
 * Map the configured adapters to what `Analytics.astro` renders, in declared
 * order. A second `vercel()` is dropped — two copies of the component would
 * count every pageview twice — so the first one keeps its position.
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
    } else {
      for (const tag of adapterScripts(adapter)) {
        nodes.push({ ...tag, type: "script" });
      }
    }
  }
  return nodes;
};
