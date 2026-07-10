import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { resolve } from "pathe";

import { ensureGitignore } from "../../core/gitignore.ts";
import { eject } from "../../registry/eject.ts";
import { collectAnswers } from "../init/questions.ts";
import {
  applyPlan,
  buildPlan,
  commandsFor,
  detectPackageManager,
  nextSteps,
  PACKAGE_MANAGERS,
  TEMPLATES,
  validateContentDir,
} from "../init/scaffold.ts";
import type {
  InitAnswers,
  PackageManager,
  Template,
} from "../init/scaffold.ts";
import { logger } from "../log.ts";

export const initCommand = defineCommand({
  args: {
    "content-dir": {
      description: "Content directory.",
      type: "string",
    },
    dir: {
      description: "Directory to scaffold into (default: current directory).",
      required: false,
      type: "positional",
    },
    eject: {
      description: "Eject to a standalone Astro project after scaffolding.",
      type: "boolean",
    },
    "package-manager": {
      description:
        "Package manager for the next-steps hint (npm|pnpm|yarn|bun).",
      type: "string",
    },
    template: {
      description: "Starter template: docs | api | sdk | changelog.",
      type: "string",
    },
    yes: {
      description: "Skip prompts and scaffold with defaults.",
      type: "boolean",
    },
  },
  meta: {
    description: "Scaffold a minimal Blume project.",
    name: "init",
  },
  async run({ args }) {
    const cwd = process.cwd();

    const template = args.template as Template | undefined;
    if (template !== undefined && !TEMPLATES.includes(template)) {
      logger.error(
        `Unknown template "${args.template}" (use ${TEMPLATES.join(" | ")}).`
      );
      process.exit(1);
    }
    const pm = args["package-manager"] as PackageManager | undefined;
    if (pm !== undefined && !PACKAGE_MANAGERS.includes(pm)) {
      logger.error(
        `Unknown package manager "${args["package-manager"]}" (use ${PACKAGE_MANAGERS.join(" | ")}).`
      );
      process.exit(1);
    }

    const interactive =
      !args.yes &&
      process.stdin.isTTY === true &&
      clack.isTTY(process.stdout) &&
      !clack.isCI();

    let answers: InitAnswers;
    if (interactive) {
      clack.intro("blume init");
      const collected = await collectAnswers(
        clack,
        {
          contentDir: args["content-dir"],
          directory: args.dir,
          packageManager: pm,
          template,
        },
        { cwd, userAgent: process.env.npm_config_user_agent }
      );
      if (collected === null) {
        clack.cancel("Cancelled — nothing was written.");
        process.exit(0);
      }
      answers = collected;
    } else {
      answers = {
        contentDir: args["content-dir"] ?? "docs",
        directory: args.dir ?? ".",
        packageManager:
          pm ?? detectPackageManager(process.env.npm_config_user_agent),
        sources: ["filesystem"],
        template: template ?? "docs",
        title: "My Docs",
      };
    }

    const root = resolve(cwd, answers.directory);
    // Interactive runs validate this inline, but an explicit --content-dir
    // flag skips that prompt, so guard here in both modes.
    if (validateContentDir(root, answers.contentDir) !== undefined) {
      logger.error(
        `Invalid --content-dir "${answers.contentDir}" (must be a path inside the project).`
      );
      process.exit(1);
    }

    const sink = interactive ? clack.log : logger;
    const { createdPackage } = await applyPlan(buildPlan(root, answers), sink);

    // Keep Blume's generated runtime (`.blume/`) and build output (`dist/`) out
    // of version control. Idempotent: creates `.gitignore` when absent and skips
    // entries already present (trailing-slash agnostic).
    const ignored = await ensureGitignore(root, [".blume/", "dist/"]);
    if (ignored.length > 0) {
      sink.success(`Added ${ignored.join(", ")} to .gitignore`);
    }

    const commands = commandsFor(answers.packageManager);

    if (args.eject) {
      // Eject only generates files (no Astro runtime), so it works right after
      // scaffolding. The standalone app then runs with Astro directly.
      try {
        await eject(root);
        logger.success("Ejected to a standalone Astro project.");
        logger.box(`Next steps:\n\n  ${commands.install}\n  npx astro dev\n`);
      } catch (error) {
        logger.warn(
          `Scaffolded, but eject failed: ${(error as Error).message}`
        );
        logger.box(
          `Next steps:\n\n  ${commands.install}\n  blume eject --yes\n`
        );
      }
      return;
    }

    const steps = nextSteps(answers, createdPackage);
    if (interactive) {
      clack.note(steps.trimEnd());
      clack.outro("You're all set.");
    } else {
      logger.box(steps);
    }
  },
});
