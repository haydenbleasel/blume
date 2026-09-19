import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions } from "./shared.ts";
import { sharedSourceOptionsSchema } from "./shared.ts";

/** Options for {@link sanity}. */
export interface SanityOptions extends SharedSourceOptions {
  /** Sanity API version (a date). Defaults to `2024-01-01`. */
  apiVersion?: string;
  /** Dataset name to query. */
  dataset: string;
  /** Field paths mapping a document onto Blume meta + body. */
  fields?: {
    /** Field holding the renderable body (Portable Text or Markdown). */
    body?: string;
    /** Field holding the page description. */
    description?: string;
    /** Field holding the last-modified date. */
    lastModified?: string;
    /** Field holding the page slug. */
    slug?: string;
    /** Field holding the page title. */
    title?: string;
  };
  /** Sanity project id. */
  projectId: string;
  /** GROQ query selecting the documents to import. */
  query: string;
}

export const sanityOptionsSchema = sharedSourceOptionsSchema.extend({
  apiVersion: z.string().optional(),
  dataset: z.string(),
  fields: z
    .strictObject({
      body: z.string().optional(),
      description: z.string().optional(),
      lastModified: z.string().optional(),
      slug: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
  projectId: z.string(),
  query: z.string(),
});

export type SanityAdapter = AdapterDescriptor<"sanity", SanityOptions>;

export const sanityAdapterSchema = adapterDescriptorSchema(
  "sanity",
  sanityOptionsSchema
);

/**
 * A Sanity dataset queried with GROQ; Portable Text bodies become Markdown.
 * `@sanity/client` is the declared runtime dependency, and a private dataset's
 * read token comes from `SANITY_TOKEN`.
 */
export const sanity = (options: SanityOptions): SanityAdapter => ({
  kind: "sanity",
  options,
  requiredSecrets: ["SANITY_TOKEN"],
  runtimeDeps: ["@sanity/client"],
});
