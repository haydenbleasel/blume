import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";

/** The props of `@vercel/analytics/astro` that {@link vercel} documents. */
export interface VercelNamedOptions {
  /** Log every event to the console. Defaults to the component's own rule (on outside production). */
  debug?: boolean;
  /** Force the script's environment instead of letting it detect one. */
  mode?: "auto" | "development" | "production";
}

/**
 * Options for {@link vercel}: the documented props plus any other prop of the
 * official component, forwarded verbatim (`endpoint`, `scriptSrc`, `dsn`, …).
 * JSON values only; `beforeSend` is a function and can't travel through
 * config — assign `window.webAnalyticsBeforeSend` from a `script()` adapter
 * listed before `vercel()` instead.
 */
export type VercelOptions = VercelNamedOptions & {
  [option: string]: JsonValue;
};

export const vercelOptionsSchema = z
  .object({
    debug: z.boolean().optional(),
    mode: z.enum(["auto", "development", "production"]).optional(),
  })
  .catchall(z.json());

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
