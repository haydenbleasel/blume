import { defineCommand, runMain } from "citty";

import { getBlumeVersion } from "../core/version.ts";
import { addCommand } from "./commands/add.ts";
import { auditCommand } from "./commands/audit.ts";
import { buildCommand } from "./commands/build.ts";
import { checkCommand } from "./commands/check.ts";
import { devCommand } from "./commands/dev.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { ejectCommand } from "./commands/eject.ts";
import { evalCommand } from "./commands/eval.ts";
import { initCommand } from "./commands/init.ts";
import { mcpStdioCommand } from "./commands/mcp-stdio.ts";
import { previewCommand } from "./commands/preview.ts";
import { syncCommand } from "./commands/sync.ts";
import { translateCommand } from "./commands/translate.ts";
import { validateCommand } from "./commands/validate.ts";
import { loadEnvFiles } from "./env.ts";
import { reportInternalError } from "./internal-error.ts";

const main = defineCommand({
  meta: {
    description: "Markdown-first documentation powered by Astro and Vite.",
    name: "blume",
    version: getBlumeVersion(),
  },
  subCommands: {
    add: addCommand,
    audit: auditCommand,
    build: buildCommand,
    check: checkCommand,
    dev: devCommand,
    doctor: doctorCommand,
    eject: ejectCommand,
    eval: evalCommand,
    init: initCommand,
    "mcp-stdio": mcpStdioCommand,
    preview: previewCommand,
    sync: syncCommand,
    translate: translateCommand,
    validate: validateCommand,
  },
});

// Load `.env`/`.env.local` before any command runs so remote content sources
// can read their tokens (e.g. `GITHUB_TOKEN`) during the content scan.
loadEnvFiles(process.cwd());

// Backstop for unexpected async failures that escape a command's own handling
// (e.g. a rejected timer/watcher in `blume dev`), so even those report through
// the stable internal-error contract rather than a bare stack trace.
process.on("uncaughtException", (error) => {
  reportInternalError(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  reportInternalError(error);
  process.exit(1);
});

runMain(main);
