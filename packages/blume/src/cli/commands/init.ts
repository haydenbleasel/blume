import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { defineCommand } from "citty";
import { dirname, join } from "pathe";

import { logger } from "../log.ts";

const CONFIG_TEMPLATE = `import { defineConfig } from "blume";

export default defineConfig({
  title: "My Docs",
  description: "Documentation powered by Blume.",
});
`;

const INDEX_TEMPLATE = `---
title: Introduction
description: Welcome to your new Blume docs.
---

# Introduction

Welcome to **Blume** — markdown-first docs powered by Astro and Vite.

Edit \`docs/index.mdx\` to get started, then run \`blume dev\`.
`;

const writeFileSafe = async (
  path: string,
  content: string
): Promise<boolean> => {
  if (existsSync(path)) {
    logger.info(`Skipped existing ${path}`);
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  logger.success(`Created ${path}`);
  return true;
};

export const initCommand = defineCommand({
  args: {
    "content-dir": {
      default: "docs",
      description: "Content directory.",
      type: "string",
    },
    yes: { description: "Skip prompts.", type: "boolean" },
  },
  meta: {
    description: "Scaffold a minimal Blume project.",
    name: "init",
  },
  async run({ args }) {
    const root = process.cwd();
    const contentDir = args["content-dir"] ?? "docs";

    await writeFileSafe(join(root, "blume.config.ts"), CONFIG_TEMPLATE);
    await writeFileSafe(join(root, contentDir, "index.mdx"), INDEX_TEMPLATE);

    logger.box("Next steps:\n\n  blume dev\n");
  },
});
