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
import { syncCommand } from "./commands/sync.ts";
import { validateCommand } from "./commands/validate.ts";

const main = defineCommand({
  meta: {
    description: "Markdown-first documentation powered by Astro and Vite.",
    name: "blume",
    version: getBlumeVersion(),
  },
  subCommands: {
    add: addCommand,
    build: buildCommand,
    dev: devCommand,
    doctor: doctorCommand,
    eject: ejectCommand,
    init: initCommand,
    migrate: migrateCommand,
    preview: previewCommand,
    sync: syncCommand,
    validate: validateCommand,
  },
});

runMain(main);
