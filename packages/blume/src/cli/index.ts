import { defineCommand, runMain } from "citty";

import { getBlumeVersion } from "../core/version.ts";
import { commandMeta } from "./command-meta.ts";
import { loadEnvFiles } from "./env.ts";
import { normalizeHostArgs } from "./host-args.ts";
import { reportInternalError } from "./internal-error.ts";
import { lazyCommand } from "./lazy-command.ts";
// consola reads CONSOLA_LEVEL / NODE_ENV / TEST / CI / DEBUG when its module
// evaluates. Import the logger here, ahead of `loadEnvFiles`, so those values
// come from the real environment — never from a project `.env`, which would
// otherwise silence or restyle every command's output. The commands are loaded
// lazily below, so without this line consola would first evaluate after `.env`
// had been applied.
import "./log.ts";

const main = defineCommand({
  meta: {
    description: "The open-source docs framework for humans and agents.",
    name: "blume",
    version: getBlumeVersion(),
  },
  subCommands: {
    add: lazyCommand(
      commandMeta.add,
      () => import("./commands/add.ts"),
      "addCommand"
    ),
    audit: lazyCommand(
      commandMeta.audit,
      () => import("./commands/audit.ts"),
      "auditCommand"
    ),
    build: lazyCommand(
      commandMeta.build,
      () => import("./commands/build.ts"),
      "buildCommand"
    ),
    check: lazyCommand(
      commandMeta.check,
      () => import("./commands/check.ts"),
      "checkCommand"
    ),
    dev: lazyCommand(
      commandMeta.dev,
      () => import("./commands/dev.ts"),
      "devCommand"
    ),
    doctor: lazyCommand(
      commandMeta.doctor,
      () => import("./commands/doctor.ts"),
      "doctorCommand"
    ),
    eject: lazyCommand(
      commandMeta.eject,
      () => import("./commands/eject.ts"),
      "ejectCommand"
    ),
    eval: lazyCommand(
      commandMeta.eval,
      () => import("./commands/eval.ts"),
      "evalCommand"
    ),
    init: lazyCommand(
      commandMeta.init,
      () => import("./commands/init.ts"),
      "initCommand"
    ),
    "mcp-stdio": lazyCommand(
      commandMeta["mcp-stdio"],
      () => import("./commands/mcp-stdio.ts"),
      "mcpStdioCommand"
    ),
    migrate: lazyCommand(
      commandMeta.migrate,
      () => import("./commands/migrate.ts"),
      "migrateCommand"
    ),
    preview: lazyCommand(
      commandMeta.preview,
      () => import("./commands/preview.ts"),
      "previewCommand"
    ),
    skill: lazyCommand(
      commandMeta.skill,
      () => import("./commands/skill.ts"),
      "skillCommand"
    ),
    sync: lazyCommand(
      commandMeta.sync,
      () => import("./commands/sync.ts"),
      "syncCommand"
    ),
    translate: lazyCommand(
      commandMeta.translate,
      () => import("./commands/translate.ts"),
      "translateCommand"
    ),
    upgrade: lazyCommand(
      commandMeta.upgrade,
      () => import("./commands/upgrade.ts"),
      "upgradeCommand"
    ),
    validate: lazyCommand(
      commandMeta.validate,
      () => import("./commands/validate.ts"),
      "validateCommand"
    ),
    version: lazyCommand(
      commandMeta.version,
      () => import("./commands/version.ts"),
      "versionCommand"
    ),
  },
});

loadEnvFiles(process.cwd());

process.on("uncaughtException", (error) => {
  reportInternalError(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  reportInternalError(error);
  process.exit(1);
});

runMain(main, { rawArgs: normalizeHostArgs(process.argv.slice(2)) });
