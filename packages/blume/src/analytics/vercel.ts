import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";

/** Options for {@link vercel}: the props of `@vercel/analytics/astro`. */
export interface VercelOptions {
  /**
   * Any other prop of the official component, forwarded verbatim (`endpoint`,
   * `scriptSrc`, `dsn`, …). Must be JSON-serializable; `beforeSend` is a
   * function and can't travel through config — assign
   * `window.webAnalyticsBeforeSend` from a `script()` adapter instead.
   */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the verbatim passthrough to `<VercelAnalytics>`; mirrors the schema's loose object (the drift guard requires it).
  [option: string]: unknown;
  /** Log every event to the console. Defaults to the component's own rule (on outside production). */
  debug?: boolean;
  /** Force the script's environment instead of letting it detect one. */
  mode?: "auto" | "development" | "production";
}

export const vercelOptionsSchema = z.looseObject({
  debug: z.boolean().optional(),
  mode: z.enum(["auto", "development", "production"]).optional(),
});

export type VercelAdapter = AdapterDescriptor<"vercel", VercelOptions>;

export const vercelAdapterSchema = adapterDescriptorSchema(
  "vercel",
  vercelOptionsSchema
);

/**
 * Vercel Web Analytics, rendered through the official Astro component, which
 * injects the first-party script Vercel serves at `/_vercel/insights` once Web
 * Analytics is enabled for the project. Needs no keys. `@vercel/analytics` is
 * one of Blume's own dependencies, so the adapter declares no runtime dep.
 */
export const vercel = (options: VercelOptions = {}): VercelAdapter => ({
  kind: "vercel",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});
