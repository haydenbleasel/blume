import type { BlumeProject } from "../../core/project-graph.ts";
import type { ResolvedSearchAdapter } from "../adapters/registry.ts";
import { buildSearchDocuments, toSearchRecords } from "../documents.ts";
import type { SearchRecord } from "../documents.ts";
import { syncAlgolia } from "./algolia.ts";
import { syncOramaCloud } from "./orama-cloud.ts";
import { syncTypesense } from "./typesense.ts";

/** Minimal logger surface the build command provides. */
export interface SyncReporter {
  start: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * The sync a hosted adapter runs after a build, closed over its options, or
 * `null` for adapters with no in-process sync (static and Pagefind indexes are
 * built locally; Mixedbread syncs out-of-band via the `mxbai` CLI).
 */
const searchSync = (
  provider: ResolvedSearchAdapter
): ((records: SearchRecord[]) => Promise<void>) | null => {
  switch (provider.kind) {
    case "algolia": {
      return (records) => syncAlgolia(records, provider.options);
    }
    case "orama-cloud": {
      return (records) => syncOramaCloud(records, provider.options);
    }
    case "typesense": {
      return (records) => syncTypesense(records, provider.options);
    }
    default: {
      return null;
    }
  }
};

/**
 * After a build, upload the per-page records to the configured hosted adapter.
 * Reads secret admin keys from the environment; if a key (or option) is
 * missing the sync is skipped with a warning rather than failing the build —
 * CI may sync in a separate step.
 */
export const syncSearchProvider = async (
  project: BlumeProject,
  reporter: SyncReporter
): Promise<void> => {
  const { provider } = project.config.search;
  const sync = searchSync(provider);
  if (!sync) {
    return;
  }

  const records = toSearchRecords(await buildSearchDocuments(project));
  reporter.start(`Syncing ${records.length} record(s) to ${provider.kind}`);

  try {
    await sync(records);
    reporter.success(`Synced ${records.length} record(s) to ${provider.kind}`);
  } catch (error) {
    // SAFETY: the three sync clients surface network/auth failures as Error
    // instances; the message is read only to annotate the skip warning.
    reporter.warn(`Search sync skipped: ${(error as Error).message}`);
  }
};
