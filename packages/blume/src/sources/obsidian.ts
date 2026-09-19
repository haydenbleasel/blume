import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions } from "./shared.ts";
import { sharedSourceOptionsSchema } from "./shared.ts";

/** Options for {@link obsidian}. */
export interface ObsidianOptions extends SharedSourceOptions {
  /** Vault folder names to skip at any depth, in addition to dot-folders. */
  exclude?: string[];
  /** Vault directory, absolute or relative to the project root. */
  vault: string;
}

export const obsidianOptionsSchema = sharedSourceOptionsSchema.extend({
  exclude: z.array(z.string()).optional(),
  vault: z.string().min(1),
});

export type ObsidianAdapter = AdapterDescriptor<"obsidian", ObsidianOptions>;

export const obsidianAdapterSchema = adapterDescriptorSchema(
  "obsidian",
  obsidianOptionsSchema
);

/**
 * An Obsidian vault, read in place. Wikilinks become route links and
 * `%%comments%%` are stripped at load time, so the vault stays the source of
 * truth — no export step and no generated notes in the repo.
 */
export const obsidian = (options: ObsidianOptions): ObsidianAdapter => ({
  kind: "obsidian",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});
