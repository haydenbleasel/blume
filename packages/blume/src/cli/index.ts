import { defineCommand, runMain } from "citty";

import { BLUME_VERSION } from "../core/version.ts";
import { addCommand } from "./commands/add.ts";
import { buildCommand } from "./commands/build.ts";
import { devCommand } from "./commands/dev.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { ejectCommand } from "./commands/eject.ts";
import { importCommand } from "./commands/import.ts";
import { initCommand } from "./commands/init.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { previewCommand } from "./commands/preview.ts";

const main = defineCommand({
  meta: {
    description: "Markdown-first documentation powered by Astro and Vite.",
    name: "blume",
    version: BLUME_VERSION,
  },
  subCommands: {
    add: addCommand,
    build: buildCommand,
    dev: devCommand,
    doctor: doctorCommand,
    eject: ejectCommand,
    import: importCommand,
    init: initCommand,
    migrate: migrateCommand,
    preview: previewCommand,
  },
});

runMain(main);
