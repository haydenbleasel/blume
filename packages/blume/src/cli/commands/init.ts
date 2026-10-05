import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { resolve } from "pathe";

import { ensureGitignore } from "../../core/gitignore.ts";
import { eject } from "../../registry/eject.ts";
import { commandMeta } from "../command-meta.ts";
import { updatePackageScripts } from "../eject-scripts.ts";
import { installDependencies } from "../init/install.ts";
import { collectAnswers } from "../init/questions.ts";
import {
  applyPlan,
  buildPlan,
  cdCommand,
  commandsFor,
  detectPackageManager,
  nextSteps,
  outsidePnpmWorkspace,
  PACKAGE_MANAGERS,
  readExistingPackage,
  TEMPLATES,
  validateContentDir,
  workspaceNote,
} from "../init/scaffold.ts";
import type { InitAnswers } from "../init/scaffold.ts";
import { logger } from "../log.ts";

/** The `cd` line that opens every next-steps hint, when one is needed. */
const cdStep = (answers: InitAnswers): string[] =>
  answers.directory === "." ? [] : [cdCommand(answers.directory)];

/**
 * Install the scaffolded project's dependencies. Interactive runs hide the
 * package manager's output behind a spinner; `--yes`/CI runs stream it. On
 * failure the scaffold is left intact and the exact retry command is printed
 * before exiting non-zero, so a CI wrapper can tell the two outcomes apart.
 */
const installScaffold = async (
  root: string,
  answers: InitAnswers,
  interactive: boolean
): Promise<void> => {
  const command = commandsFor(answers.packageManager).install;
  const spinner = interactive ? clack.spinner() : undefined;
  if (spinner) {
    spinner.start(`Installing dependencies (${command})`);
  } else {
    logger.info(`Installing dependencies (${command})…`);
  }
  const outcome = await installDependencies(root, answers.packageManager, {
    quiet: interactive,
  });
  if (outcome.failure === undefined) {
    if (spinner) {
      spinner.stop("Installed dependencies");
    } else {
      logger.success("Installed dependencies");
    }
    return;
  }
  const retry = [...cdStep(answers), command];
  const hint = `Project created successfully, but dependency installation failed.\n\nRetry with:\n\n  ${retry.join("\n  ")}\n`;
  if (spinner) {
    spinner.stop("Dependency installation failed");
    clack.log.error(outcome.failure);
    clack.note(hint.trimEnd());
    clack.outro("Scaffolded without dependencies.");
  } else {
    logger.error(outcome.failure);
    logger.box(hint.trimEnd());
  }
  process.exit(1);
};

/**
 * Eject the freshly scaffolded project, or print the install-then-eject path.
 * Eject jiti-loads the scaffolded blume.config.ts, whose `import { defineConfig }
 * from "blume"` only resolves once dependencies are installed (or blume is
 * hoisted from an ancestor node_modules, as in a monorepo) — so the fallback
 * below is the common path when the install step was skipped.
 */
const ejectScaffold = async (
  root: string,
  answers: InitAnswers,
  needsInstall: boolean
): Promise<void> => {
  const commands = commandsFor(answers.packageManager);
  const cd = cdStep(answers);
  const install = needsInstall ? [commands.install] : [];
  try {
    const { dependencies } = await eject(root);
    // The scaffolded scripts point at the Blume CLI; the ejected app runs
    // Astro directly (mirroring the standalone `blume eject` command).
    const added = await updatePackageScripts(root, dependencies);
    logger.success("Ejected to a standalone Astro project.");
    // The packages eject added aren't installed yet, even when the scaffold's
    // own install already ran, so install comes first either way.
    const ejectInstall = added.length > 0 ? [commands.install] : install;
    const steps = [...cd, ...ejectInstall, commands.dev];
    logger.box(`Next steps:\n\n  ${steps.join("\n  ")}`);
  } catch (error) {
    // SAFETY: eject and the script rewrite throw Error instances; only the
    // message is surfaced in the fallback hint.
    const { message } = error as Error;
    // Only a skipped install explains the failure; after an install that ran,
    // the error itself is the reason.
    logger.warn(
      needsInstall
        ? `Scaffolded, but eject needs the project's dependencies installed to load blume.config.ts: ${message}`
        : `Scaffolded, but eject failed: ${message}`
    );
    const steps = [...cd, ...install, `${commands.exec} blume eject --yes`];
    logger.box(`Next steps:\n\n  ${steps.join("\n  ")}`);
  }
};

/**
 * Print the closing next steps. An existing package.json was left alone, so
 * the steps add what it lacks; a workspace `note` already printed ahead of an
 * install that ran, so it closes the steps only when the install is still the
 * user's to run.
 */
const printNextSteps = async (
  root: string,
  answers: InitAnswers,
  outcome: {
    createdPackage: boolean;
    interactive: boolean;
    needsInstall: boolean;
    note: string | undefined;
  }
): Promise<void> => {
  const existing = outcome.createdPackage
    ? undefined
    : await readExistingPackage(root);
  const steps = nextSteps(
    answers,
    outcome.needsInstall,
    existing,
    outcome.needsInstall ? outcome.note : undefined
  );
  if (outcome.interactive) {
    clack.note(steps.trimEnd());
    clack.outro("You're all set.");
  } else {
    // consola's box pads its content itself; a trailing newline would add
    // blank rows at the bottom.
    logger.box(steps.trimEnd());
  }
};

/**
 * Validate the enum-valued flags up front, exiting with the accepted values
 * on a typo so a bad flag never reaches the prompts.
 */
const resolveFlags = (args: {
  "package-manager"?: string;
  template?: string;
}) => {
  const template = TEMPLATES.find((candidate) => candidate === args.template);
  if (args.template !== undefined && template === undefined) {
    logger.error(
      `Unknown template "${args.template}" (use ${TEMPLATES.join(" | ")}).`
    );
    process.exit(1);
  }
  const pm = PACKAGE_MANAGERS.find(
    (candidate) => candidate === args["package-manager"]
  );
  if (args["package-manager"] !== undefined && pm === undefined) {
    logger.error(
      `Unknown package manager "${args["package-manager"]}" (use ${PACKAGE_MANAGERS.join(" | ")}).`
    );
    process.exit(1);
  }
  return { pm, template };
};

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
    install: {
      default: true,
      description: "Install dependencies after scaffolding.",
      negativeDescription: "Skip installing dependencies after scaffolding.",
      type: "boolean",
    },
    "package-manager": {
      description:
        "Package manager to install with and print in the next steps (npm|pnpm|yarn|bun).",
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
  meta: commandMeta.init,
  async run({ args }) {
    const cwd = process.cwd();
    const { pm, template } = resolveFlags(args);

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
        clack.cancel("Canceled — nothing was written.");
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
    const env = { userAgent: process.env.npm_config_user_agent };
    const { createdPackage } = await applyPlan(
      buildPlan(root, answers, env),
      sink
    );
    // A workspace the project joins keeps its own package-manager config,
    // which `init` leaves alone; say what it still needs before installing.
    const note = workspaceNote(root, answers, env);

    // Keep installed dependencies, Blume's generated runtime (`.blume/`),
    // build output (`dist/`), and local secrets (`.env.local`, where every
    // missing-secret warning says to put them) out of version control.
    // Idempotent: creates `.gitignore` when absent and skips entries already
    // present (trailing-slash agnostic).
    const ignored = await ensureGitignore(root, [
      "node_modules/",
      ".blume/",
      "dist/",
      ".env.local",
    ]);
    if (ignored.length > 0) {
      sink.success(`Added ${ignored.join(", ")} to .gitignore`);
    }

    // A newly written package.json is the only one `init` knows lists blume;
    // an existing one is left alone, and so are its dependencies. In a pnpm
    // workspace that doesn't list the folder, an install would exit 0 without
    // installing it, so that one waits until the note's change is made.
    const shouldInstall =
      createdPackage && args.install && !outsidePnpmWorkspace(root, answers);
    if (note) {
      (interactive ? clack.log : logger).warn(note);
    }
    if (shouldInstall) {
      await installScaffold(root, answers, interactive);
    }
    const needsInstall = createdPackage && !shouldInstall;

    if (args.eject) {
      await ejectScaffold(root, answers, needsInstall);
      return;
    }

    await printNextSteps(root, answers, {
      createdPackage,
      interactive,
      needsInstall,
      note,
    });
  },
});
