import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions, SourceFieldMap } from "./shared.ts";
import {
  queryParamsSchema,
  sharedSourceOptionsSchema,
  sourceFieldMapSchema,
} from "./shared.ts";

/** Options for {@link strapi}. */
export interface StrapiOptions extends SharedSourceOptions {
  /** The content type's plural API id (`articles`). */
  contentType: string;
  /**
   * Field paths mapping an entry onto Blume meta + body. Defaults to
   * `title` / `description` / `slug` / `content` / `updatedAt`.
   */
  fields?: SourceFieldMap;
  /** Locale code to fetch, for a localized content type. */
  locale?: string;
  /** Extra query parameters for the request (`"filters[section][$eq]": "sdk"`). */
  params?: Record<string, string>;
  /** The `populate` parameter. Defaults to `*`, which fills media and relations. */
  populate?: string;
  /** The Strapi origin (`https://cms.acme.dev`); its REST API is at `/api`. */
  url: string;
}

export const strapiOptionsSchema = sharedSourceOptionsSchema.extend({
  contentType: z.string(),
  fields: sourceFieldMapSchema.optional(),
  locale: z.string().optional(),
  params: queryParamsSchema.optional(),
  populate: z.string().optional(),
  url: z.string(),
});

export type StrapiAdapter = AdapterDescriptor<"strapi", StrapiOptions>;

export const strapiAdapterSchema = adapterDescriptorSchema(
  "strapi",
  strapiOptionsSchema
);

/**
 * A Strapi content type read through its REST API; Blocks bodies become
 * Markdown. The API token comes from `STRAPI_API_TOKEN`, and `--preview`
 * reads drafts. Nothing to install: the adapter speaks the REST API
 * directly.
 */
export const strapi = (options: StrapiOptions): StrapiAdapter => ({
  kind: "strapi",
  options,
  requiredSecrets: ["STRAPI_API_TOKEN"],
  runtimeDeps: [],
});
