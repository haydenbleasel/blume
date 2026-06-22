import { defineCommand, runMain } from "citty";

import { BLUME_VERSION } from "../core/version.ts";
import { buildCommand } from "./commands/build.ts";
import { devCommand } from "./commands/dev.ts";
import { initCommand } from "./commands/init.ts";
import { previewCommand } from "./commands/preview.ts";

const main = defineCommand({
  meta: {
    description: "Markdown-first documentation powered by Astro and Vite.",
    name: "blume",
    version: BLUME_VERSION,
  },
  subCommands: {
    build: buildCommand,
    dev: devCommand,
    init: initCommand,
    preview: previewCommand,
  },
});

runMain(main);
