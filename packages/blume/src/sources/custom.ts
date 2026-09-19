import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { ContentSource } from "../core/sources/types.ts";

/** A user-provided {@link ContentSource} instance, validated for `name` + `load`. */
export const customOptionsSchema = z.custom<ContentSource>(
  (value): value is ContentSource =>
    typeof value === "object" &&
    value !== null &&
    "load" in value &&
    typeof value.load === "function" &&
    "name" in value &&
    typeof value.name === "string",
  { message: "custom() takes a ContentSource (an object with name + load)" }
);

export type CustomAdapter = AdapterDescriptor<"custom", ContentSource>;

export const customAdapterSchema = adapterDescriptorSchema(
  "custom",
  customOptionsSchema
);

/**
 * Any object implementing the {@link ContentSource} interface, passed straight
 * through. This is the extension point for adapters with custom serializers or
 * any other backend, without their SDKs touching core. Unlike the built-in
 * adapters the descriptor carries a live instance, so it never travels through
 * the generated project's data snapshot — the CLI consumes it at scan time.
 */
export const custom = (source: ContentSource): CustomAdapter => ({
  kind: "custom",
  options: source,
  requiredSecrets: [],
  runtimeDeps: [],
});
