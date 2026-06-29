import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { defineCommand } from "citty";
import { dirname, join } from "pathe";

import { findItem, packageSrc, registry } from "../../registry/registry.ts";
import { rewriteImports } from "../../registry/rewrite-imports.ts";
import { logger } from "../log.ts";

export const addCommand = defineCommand({
  args: {
    force: { description: "Overwrite existing files.", type: "boolean" },
    name: {
      description: "Registry item to install.",
      required: false,
      type: "positional",
    },
  },
  meta: {
    description: "Install a source component or template from the registry.",
    name: "add",
  },
  async run({ args }) {
    const root = process.cwd();

    if (!args.name) {
      logger.info("Available registry items:");
      for (const item of registry) {
        process.stdout.write(`  ${item.name} — ${item.description}\n`);
      }
      return;
    }

    const item = findItem(args.name);
    if (!item) {
      logger.error(`Unknown registry item: ${args.name}`);
      logger.info(`Run \`blume add\` to list available items.`);
      process.exit(1);
    }

    const plan = item.files.map((file) => ({
      file,
      skip: existsSync(join(root, file.target)) && !args.force,
      target: join(root, file.target),
    }));

    await Promise.all(
      plan
        .filter((entry) => !entry.skip)
        .map(async (entry) => {
          const source = join(packageSrc, entry.file.source);
          const raw = await readFile(source, "utf-8");
          // Built-in components carry relative imports into the package; rewrite
          // them to `blume/*` so the installed copy resolves them.
          const content = entry.file.rewrite
            ? rewriteImports(raw, source, packageSrc)
            : raw;
          await mkdir(dirname(entry.target), { recursive: true });
          await writeFile(entry.target, content, "utf-8");
        })
    );

    for (const entry of plan) {
      if (entry.skip) {
        logger.warn(
          `Skipped existing ${entry.file.target} (use --force to overwrite)`
        );
      } else {
        logger.success(`Added ${entry.file.target}`);
      }
    }

    if (item.postInstall.length > 0) {
      process.stdout.write(`\nNext steps:\n`);
      for (const line of item.postInstall) {
        process.stdout.write(`  ${line}\n`);
      }
    }
  },
});
