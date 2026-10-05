import { BlumeError } from "../../core/diagnostics.ts";
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

/** A hosted adapter's build-time sync. */
interface HostedSync {
  /** The env var holding the admin key the sync reads. */
  key: string;
  /**
   * Whether the sync is set up to run: its admin key is set, and for Orama
   * Cloud, the `indexId` that turns the sync on.
   */
  ready: boolean;
  /** The upload, closed over the adapter's options. */
  run: (records: SearchRecord[]) => Promise<void>;
}

/**
 * The sync a hosted adapter runs after a build, or `null` for adapters with no
 * in-process sync (static and Pagefind indexes are built locally; Mixedbread
 * syncs out-of-band via the `mxbai` CLI).
 */
const searchSync = (provider: ResolvedSearchAdapter): HostedSync | null => {
  switch (provider.kind) {
    case "algolia": {
      const key = "ALGOLIA_ADMIN_API_KEY";
      return {
        key,
        ready: Boolean(process.env[key]),
        run: (records) => syncAlgolia(records, provider.options),
      };
    }
    case "orama-cloud": {
      const key = "ORAMA_PRIVATE_API_KEY";
      return {
        key,
        ready: Boolean(process.env[key] && provider.options.indexId),
        run: (records) => syncOramaCloud(records, provider.options),
      };
    }
    case "typesense": {
      const key = "TYPESENSE_ADMIN_API_KEY";
      return {
        key,
        ready: Boolean(process.env[key]),
        run: (records) => syncTypesense(records, provider.options),
      };
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
 * a local build has no secrets, and CI may sync in a separate step. Once the
 * sync is set up, a failure fails the build (`BLUME_SEARCH_SYNC_FAILED`):
 * the site would otherwise deploy against an index this build didn't update.
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
    await sync.run(records);
    reporter.success(`Synced ${records.length} record(s) to ${provider.kind}`);
  } catch (error) {
    // SAFETY: the three sync clients surface network/auth failures as Error
    // instances; the message is read only to annotate the warning or error.
    const { message } = error as Error;
    if (!sync.ready) {
      reporter.warn(`Search sync skipped: ${message}`);
      return;
    }
    throw new BlumeError({
      code: "BLUME_SEARCH_SYNC_FAILED",
      message: `Search sync to ${provider.kind} failed: ${message}`,
      severity: "error",
      suggestion: `Check ${sync.key} and the adapter's options, or unset ${sync.key} to build without syncing.`,
    });
  }
};
