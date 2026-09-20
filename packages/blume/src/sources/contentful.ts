import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions, SourceFieldMap } from "./shared.ts";
import {
  queryParamsSchema,
  sharedSourceOptionsSchema,
  sourceFieldMapSchema,
} from "./shared.ts";

/** Options for {@link contentful}. */
export interface ContentfulOptions extends SharedSourceOptions {
  /** The content type id whose entries become pages. */
  contentType: string;
  /** Environment id. Defaults to `master`. */
  environment?: string;
  /**
   * Field ids mapping an entry onto Blume meta + body; `sys.<key>` reaches
   * the entry's `sys`. Defaults to `title` / `description` / `slug` / `body`
   * / `sys.updatedAt`.
   */
  fields?: SourceFieldMap;
  /** Locale code to fetch; omit for the space's default locale. */
  locale?: string;
  /** Extra query parameters for the entries request (`"fields.section": "sdk"`). */
  params?: Record<string, string>;
  /** Space id. */
  space: string;
}

export const contentfulOptionsSchema = sharedSourceOptionsSchema.extend({
  contentType: z.string(),
  environment: z.string().optional(),
  fields: sourceFieldMapSchema.optional(),
  locale: z.string().optional(),
  params: queryParamsSchema.optional(),
  space: z.string(),
});

export type ContentfulAdapter = AdapterDescriptor<
  "contentful",
  ContentfulOptions
>;

export const contentfulAdapterSchema = adapterDescriptorSchema(
  "contentful",
  contentfulOptionsSchema
);

/**
 * A Contentful content type read through the Delivery API; rich text bodies
 * become Markdown. The Delivery token comes from `CONTENTFUL_ACCESS_TOKEN`,
 * and `--preview` reads drafts through the Preview API with
 * `CONTENTFUL_PREVIEW_TOKEN`. Nothing to install: the adapter speaks the
 * REST API directly.
 */
export const contentful = (options: ContentfulOptions): ContentfulAdapter => ({
  kind: "contentful",
  options,
  requiredSecrets: ["CONTENTFUL_ACCESS_TOKEN"],
  runtimeDeps: [],
});
