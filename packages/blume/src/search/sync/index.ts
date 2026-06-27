import type { BlumeProject } from "../../core/project-graph.ts";
import { buildSearchDocuments, toSearchRecords } from "../documents.ts";
import { searchProviderMeta } from "../providers.ts";
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
 * After a build, upload the per-page records to the configured hosted provider.
 * Reads secret admin keys from the environment; if a key (or config) is
 * missing the sync is skipped with a warning rather than failing the build —
 * CI may sync in a separate step. Providers without an in-process sync
 * (Mixedbread, which uses the `mxbai` CLI) are no-ops here.
 */
export const syncSearchProvider = async (
  project: BlumeProject,
  reporter: SyncReporter
): Promise<void> => {
  const { search } = project.config;
  if (!searchProviderMeta(search.provider).syncs) {
    return;
  }

  const records = toSearchRecords(await buildSearchDocuments(project));
  reporter.start(`Syncing ${records.length} record(s) to ${search.provider}`);

  try {
    switch (search.provider) {
      case "algolia": {
        await syncAlgolia(records, search.algolia);
        break;
      }
      case "orama-cloud": {
        await syncOramaCloud(records, search.oramaCloud);
        break;
      }
      case "typesense": {
        await syncTypesense(records, search.typesense);
        break;
      }
      default: {
        return;
      }
    }
    reporter.success(
      `Synced ${records.length} record(s) to ${search.provider}`
    );
  } catch (error) {
    reporter.warn(`Search sync skipped: ${(error as Error).message}`);
  }
};
