import { existsSync } from "node:fs";

import { preview } from "astro";
import { defineCommand } from "citty";
import { join } from "pathe";

import { loadConfig } from "../../core/config.ts";
import { resolveProjectContext } from "../../core/project.ts";
import { parsePort } from "../args.ts";
import { logger } from "../log.ts";
import { normalizeHost } from "./dev.ts";

export const previewCommand = defineCommand({
  args: {
    host: { description: "Network host to bind.", type: "string" },
    port: { description: "Port to listen on.", type: "string" },
  },
  meta: {
    description: "Preview the last production build.",
    name: "preview",
  },
  async run({ args }) {
    const root = process.cwd();
    const { config } = await loadConfig(root);
    const context = resolveProjectContext(root, config);

    if (!existsSync(join(context.outDir, "astro.config.mjs"))) {
      logger.error("No build found. Run `blume build` first.");
      process.exit(1);
    }

    await preview({
      logLevel: "info",
      root: context.outDir,
      server: {
        // `normalizeHost` maps a bare `--host` (citty parses it as "") to
        // `true` so Vite binds all interfaces instead of the hostname "".
        host: normalizeHost(args.host),
        port: parsePort(args.port),
      },
    });
  },
});
