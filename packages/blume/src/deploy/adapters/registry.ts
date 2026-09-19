import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../../core/adapter.ts";
import { cloudflare, cloudflareAdapterSchema } from "./cloudflare.ts";
import type { CloudflareAdapter } from "./cloudflare.ts";
import { netlify, netlifyAdapterSchema } from "./netlify.ts";
import type { NetlifyAdapter } from "./netlify.ts";
import { node, nodeAdapterSchema } from "./node.ts";
import type { NodeAdapter } from "./node.ts";
import type { DeployOutput, StaticDeployment } from "./types.ts";
import { vercel, vercelAdapterSchema } from "./vercel.ts";
import type { VercelAdapter } from "./vercel.ts";

/** Every descriptor a host adapter factory can return. */
export type AnyDeployAdapter =
  | CloudflareAdapter
  | NetlifyAdapter
  | NodeAdapter
  | VercelAdapter;

/** Every adapter identity, including the resolved `static` default. */
export type DeployAdapterKind = "static" | AnyDeployAdapter["kind"];

/**
 * A resolved deployment's options: `output` is always present (a host adapter
 * defaults to `server`, the static form is `static`), and anything else the
 * adapter was given rides along for the `@astrojs/*` constructor.
 */
export type ResolvedDeployOptions = {
  base?: string;
  output: DeployOutput;
  site?: string;
} & { [option: string]: JsonValue };

/**
 * What `config.deployment` resolves to: the descriptor the factory returned
 * with `output` filled in, or the `static` descriptor for the plain form.
 */
export type ResolvedDeployment = AdapterDescriptor<
  DeployAdapterKind,
  ResolvedDeployOptions
>;

/** What `blume.config.ts` accepts under `deployment`. */
export type DeploymentInput = AnyDeployAdapter | StaticDeployment;

const HINT =
  'deployment takes a host adapter from "blume/deploy" — e.g. `deployment: vercel()`, `netlify({ output: "static" })`, `node({ site })` — or `{ site, base }` for a static build on any host. The 1.x `adapter`/`output` fields were removed.';

/**
 * The static form, `{ site?, base? }`. Its discriminator is optional so the
 * union resolves a plain object (and `{}`) to it; the 1.x object form fails
 * here on its unrecognized `adapter`/`output` keys with the adapter hint.
 */
const staticDeploymentSchema = z.strictObject(
  {
    base: z.string().optional(),
    kind: z.literal("static").optional(),
    site: z.url().optional(),
  },
  {
    error: (issue) => (issue.code === "unrecognized_keys" ? HINT : undefined),
  }
);

/** The union `deployment` is validated against, before resolution. */
const deploymentInputSchema = z.discriminatedUnion(
  "kind",
  [
    cloudflareAdapterSchema,
    netlifyAdapterSchema,
    nodeAdapterSchema,
    vercelAdapterSchema,
    staticDeploymentSchema,
  ],
  {
    error: (issue) =>
      issue.code === "invalid_union" || issue.code === "invalid_type"
        ? HINT
        : undefined,
  }
);

/** A host adapter with `output` resolved: unset means a server build. */
const resolveHost = (adapter: AnyDeployAdapter): ResolvedDeployment => ({
  ...adapter,
  options: { ...adapter.options, output: adapter.options.output ?? "server" },
});

/**
 * Validates what a factory returned (or the plain static form) and resolves
 * it to the canonical descriptor, re-derived through the factory so a
 * descriptor that went through JSON carries the same metadata Blume ships.
 * `static` is internal: `kind: "static"` is admitted but never needed.
 */
export const resolvedDeploymentSchema = deploymentInputSchema.transform(
  (value): ResolvedDeployment => {
    switch (value.kind) {
      case "cloudflare": {
        return resolveHost(cloudflare(value.options));
      }
      case "netlify": {
        return resolveHost(netlify(value.options));
      }
      case "node": {
        return resolveHost(node(value.options));
      }
      case "vercel": {
        return resolveHost(vercel(value.options));
      }
      default: {
        // The static form (`kind` unset or "static") is resolved after the
        // switch rather than in this block: Bun 1.4.0's line coverage never
        // credits the closing brace of a switch's final block.
        break;
      }
    }
    const options: ResolvedDeployOptions = { output: "static" };
    if (value.base !== undefined) {
      options.base = value.base;
    }
    if (value.site !== undefined) {
      options.site = value.site;
    }
    return { kind: "static", options, requiredSecrets: [], runtimeDeps: [] };
  }
);
