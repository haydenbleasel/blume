import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions, SourceFieldMap } from "./shared.ts";
import {
  queryParamsSchema,
  sharedSourceOptionsSchema,
  sourceFieldMapSchema,
} from "./shared.ts";

/** Options for {@link payload}. */
export interface PayloadOptions extends SharedSourceOptions {
  /**
   * The auth-enabled collection the API key belongs to. Defaults to `users`;
   * it names the scheme in the `Authorization` header (`users API-Key <key>`).
   */
  authCollection?: string;
  /** The collection slug whose documents become pages. */
  collection: string;
  /** Relationship depth to populate. Defaults to `1`, enough for upload URLs. */
  depth?: number;
  /**
   * Field paths mapping a document onto Blume meta + body. Defaults to
   * `title` / `description` / `slug` / `content` / `updatedAt`.
   */
  fields?: SourceFieldMap;
  /** Extra query parameters for the collection request (`"where[status][equals]": "live"`). */
  params?: Record<string, string>;
  /** The Payload app's origin (`https://cms.acme.dev`); its REST API is at `/api`. */
  url: string;
}

export const payloadOptionsSchema = sharedSourceOptionsSchema.extend({
  authCollection: z.string().optional(),
  collection: z.string(),
  depth: z.number().int().nonnegative().optional(),
  fields: sourceFieldMapSchema.optional(),
  params: queryParamsSchema.optional(),
  url: z.string(),
});

export type PayloadAdapter = AdapterDescriptor<"payload", PayloadOptions>;

export const payloadAdapterSchema = adapterDescriptorSchema(
  "payload",
  payloadOptionsSchema
);

/**
 * A Payload collection read through its REST API; Lexical bodies become
 * Markdown. The API key comes from `PAYLOAD_API_KEY`, and `--preview` reads
 * drafts. Nothing to install: the adapter speaks the REST API directly.
 */
export const payload = (options: PayloadOptions): PayloadAdapter => ({
  kind: "payload",
  options,
  requiredSecrets: ["PAYLOAD_API_KEY"],
  runtimeDeps: [],
});
