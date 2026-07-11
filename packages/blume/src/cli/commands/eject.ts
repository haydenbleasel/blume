import { defineCommand } from "citty";
import { relative } from "pathe";

import { loadConfig } from "../../core/config.ts";
import { eject } from "../../registry/eject.ts";
import { refuseIfDevRunning } from "../dev-lock.ts";
import {
  droppedArtifactNotices,
  updatePackageScripts,
} from "../eject-scripts.ts";
import { commandsFor, detectPackageManager } from "../init/scaffold.ts";
import { logger } from "../log.ts";

/**
 * Warn which `blume build` post-build artifacts the ejected app stops
 * producing. Printed both at the confirmation (so the decision is informed)
 * and after `--yes` (so a direct eject still sees it). No-op when the config
 * activates none of them.
 */
const reportDroppedArtifacts = (notices: string[]): void => {
  if (notices.length === 0) {
    return;
  }
  logger.warn(
    [
      "The ejected build script runs plain `astro build`, which stops producing these `blume build` artifacts:",
      ...notices.map((notice) => `  - ${notice}`),
    ].join("\n")
  );
};

export const ejectCommand = defineCommand({
  args: {
    yes: { description: "Skip the confirmation prompt.", type: "boolean" },
  },
  meta: {
    description: "Promote the generated runtime into an owned Astro project.",
    name: "eject",
  },
  async run({ args }) {
    const root = process.cwd();
    refuseIfDevRunning(root, "ejecting");

    // Config-aware drop list: only the artifacts this project actually
    // produces are mentioned (e.g. the Pagefind index only for
    // `search.provider: "pagefind"`).
    let notices: string[] = [];
    try {
      const { config } = await loadConfig(root);
      notices = droppedArtifactNotices(config);
    } catch {
      // A config that fails to load can't gate the notice; the eject itself
      // surfaces the load error.
    }

    if (!args.yes) {
      logger.warn(
        "Eject is one-way: it writes astro.config.mjs, src/, and (if absent) tsconfig.json, rewrites your package.json scripts, and removes .blume. An existing tsconfig.json is left untouched."
      );
      reportDroppedArtifacts(notices);
      logger.info("Re-run with --yes to proceed.");
      return;
    }

    const { files, warnings } = await eject(root);
    await updatePackageScripts(root);

    // The same surface as the generated-runtime path (prepare.ts): one warn
    // per generation warning, e.g. a Scalar reference spec that wasn't found.
    for (const warning of warnings) {
      logger.warn(warning);
    }

    logger.success(`Ejected ${files.length} file(s):`);
    for (const file of files) {
      process.stdout.write(`  ${relative(root, file)}\n`);
    }
    reportDroppedArtifacts(notices);
    // Print run commands matching the user's package manager, detected the
    // same way as `blume init`'s next-steps hint.
    const pm = detectPackageManager(process.env.npm_config_user_agent);
    const { dev } = commandsFor(pm);
    // `commandsFor` has no build entry; mirror its npm-needs-`run` rule.
    const build = pm === "npm" ? "npm run build" : `${pm} build`;
    logger.box(
      `Your project is now a standalone Astro app.\n\n  ${dev}\n  ${build}\n\nThe blume package remains importable.`
    );
  },
});
