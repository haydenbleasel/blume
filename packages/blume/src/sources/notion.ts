import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions } from "./shared.ts";
import { sharedSourceOptionsSchema } from "./shared.ts";

/** Options for {@link notion}. */
export interface NotionOptions extends SharedSourceOptions {
  /** Max concurrent Notion API requests; default 3 (Notion's per-integration pace). */
  concurrency?: number;
  /** Notion database id. */
  database: string;
  /** Notion property names mapped onto Blume meta. */
  properties?: {
    /** Property holding the page description. */
    description?: string;
    /** Property holding the sort order. */
    order?: string;
    /** Property holding the page slug. */
    slug?: string;
    /** Property holding the publish status. */
    status?: string;
    /** Property holding the page title. */
    title?: string;
  };
  /** Status value treated as published; others map to `draft`. Defaults to `Published`. */
  publishedValue?: string;
}

export const notionOptionsSchema = sharedSourceOptionsSchema.extend({
  concurrency: z.number().positive().optional(),
  database: z.string(),
  properties: z
    .strictObject({
      description: z.string().optional(),
      order: z.string().optional(),
      slug: z.string().optional(),
      status: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
  publishedValue: z.string().optional(),
});

export type NotionAdapter = AdapterDescriptor<"notion", NotionOptions>;

export const notionAdapterSchema = adapterDescriptorSchema(
  "notion",
  notionOptionsSchema
);

/**
 * A Notion database; pages become entries, blocks become MDX. `@notionhq/client`
 * is the declared runtime dependency, and the integration token comes from
 * `NOTION_TOKEN`.
 */
export const notion = (options: NotionOptions): NotionAdapter => ({
  kind: "notion",
  options,
  requiredSecrets: ["NOTION_TOKEN"],
  runtimeDeps: ["@notionhq/client"],
});
