import { defineCommand } from "citty";

import { loadConfig } from "../../core/config.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { CutError, cutVersion } from "../../core/version-cut.ts";
import { reportInternalError } from "../internal-error.ts";
import { logger } from "../log.ts";

export const versionCommand = defineCommand({
  args: {
    force: {
      description: "Overwrite an existing snapshot directory.",
      type: "boolean",
    },
    id: {
      description: 'Version id to cut (e.g. "v1.0").',
      required: false,
      type: "positional",
    },
  },
  meta: {
    description: "Freeze the current docs as an archived version.",
    name: "version",
  },
  async run({ args }) {
    const root = process.cwd();

    if (!args.id) {
      const { config } = await loadConfig(root);
      if (!config.versions) {
        logger.info(
          "Versioning is not configured. Cut the first version with `blume version <id>` (e.g. `blume version v1.0`)."
        );
        return;
      }
      const { current, archived } = config.versions;
      process.stdout.write(
        `  ${current.label} (current)${current.badge ? ` — ${current.badge}` : ""}\n`
      );
      for (const version of archived) {
        process.stdout.write(
          `  ${version.label ?? version.id} — ${version.id}/\n`
        );
      }
      return;
    }

    try {
      const result = await cutVersion(root, args.id, { force: args.force });
      logger.success(
        `Snapshot ${result.dir} (${result.copied} file(s) copied)`
      );
      const totalRewrites = result.rewritten.reduce(
        (sum, entry) => sum + entry.count,
        0
      );
      if (totalRewrites > 0) {
        logger.info(
          `Rewrote root-absolute links in ${result.rewritten.length} page(s) (${totalRewrites} line(s)).`
        );
      }
      if (result.configUpdated) {
        logger.success(
          `Added "${args.id}" to versions.archived in blume.config.ts`
        );
      } else if (result.configSnippet) {
        logger.info(result.configSnippet);
      }
      logger.info(
        "Archived versions are frozen — future edits belong in the live tree. Restart `blume dev` to pick up the snapshot."
      );
    } catch (error) {
      if (error instanceof CutError) {
        logger.error(error.message);
        process.exit(1);
      }
      if (error instanceof BlumeError) {
        logger.error(error.diagnostic.message);
        process.exit(1);
      }
      reportInternalError(error);
      process.exit(1);
    }
  },
});
