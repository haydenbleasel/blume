import { defineCommand } from "citty";

import { migrators } from "../../migrate/migrate.ts";
import { logger } from "../log.ts";

const makeMigrateCommand = (source: keyof typeof migrators) =>
  defineCommand({
    meta: {
      description: `Migrate a ${source} project to Blume.`,
      name: source,
    },
    async run() {
      const root = process.cwd();
      logger.start(`Migrating ${source} project`);
      const result = await migrators[source]?.(root);
      if (!result) {
        logger.error(`No migrator for ${source}.`);
        process.exit(1);
      }
      logger.success(`Migrated ${result.moved} content file(s).`);
      for (const warning of result.warnings) {
        logger.warn(warning);
      }
      logger.box("Review blume.config.ts and run `blume dev`.");
    },
  });

export const migrateCommand = defineCommand({
  meta: {
    description: "Migrate from another docs tool to Blume.",
    name: "migrate",
  },
  subCommands: {
    fumadocs: makeMigrateCommand("fumadocs"),
    mintlify: makeMigrateCommand("mintlify"),
    starlight: makeMigrateCommand("starlight"),
  },
});
