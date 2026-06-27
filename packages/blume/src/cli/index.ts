import { defineCommand, runMain } from "citty";

import { getBlumeVersion } from "../core/version.ts";
import { addCommand } from "./commands/add.ts";
import { buildCommand } from "./commands/build.ts";
import { devCommand } from "./commands/dev.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { ejectCommand } from "./commands/eject.ts";
import { initCommand } from "./commands/init.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { previewCommand } from "./commands/preview.ts";
import { validateCommand } from "./commands/validate.ts";
import { logger } from "./log.ts";

const cliName = process.env.BLUME_CLI_NAME === "mint" ? "mint" : "blume";

const unsupportedMintCommand = (name: string) =>
  defineCommand({
    meta: {
      description: "Unsupported Mintlify platform or quality command.",
      name,
    },
    run() {
      logger.error(
        [
          `\`mint ${name}\` is not supported by Blume's local Mintlify compatibility.`,
          "Blume supports `mint dev`, `mint build`, and `mint preview` for running existing Mintlify projects locally.",
        ].join("\n")
      );
      process.exit(1);
    },
  });

const blumeSubCommands = {
  add: addCommand,
  build: buildCommand,
  dev: devCommand,
  doctor: doctorCommand,
  eject: ejectCommand,
  init: initCommand,
  migrate: migrateCommand,
  preview: previewCommand,
  validate: validateCommand,
};

const mintSubCommands = {
  a11y: unsupportedMintCommand("a11y"),
  "broken-links": unsupportedMintCommand("broken-links"),
  build: buildCommand,
  config: unsupportedMintCommand("config"),
  dev: devCommand,
  export: unsupportedMintCommand("export"),
  login: unsupportedMintCommand("login"),
  logout: unsupportedMintCommand("logout"),
  preview: previewCommand,
  rename: unsupportedMintCommand("rename"),
  score: unsupportedMintCommand("score"),
  status: unsupportedMintCommand("status"),
  validate: unsupportedMintCommand("validate"),
};

const main = defineCommand({
  meta: {
    description: "Markdown-first documentation powered by Astro and Vite.",
    name: cliName,
    version: getBlumeVersion(),
  },
  subCommands: cliName === "mint" ? mintSubCommands : blumeSubCommands,
});

await runMain(main);
