import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { defineCommand } from "citty";
import { basename, dirname, join } from "pathe";

import { getBlumeVersion } from "../../core/version.ts";
import { logger } from "../log.ts";

/**
 * Derive a valid npm package name from a directory name, falling back to
 * `docs` when nothing usable remains.
 */
const toPackageName = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^[-_.]+|[-_.]+$/gu, "") || "docs";

const packageTemplate = (name: string, version: string): string => `{
  "name": ${JSON.stringify(name)},
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "blume dev",
    "build": "blume build",
    "doctor": "blume doctor"
  },
  "dependencies": {
    "blume": "^${version}"
  }
}
`;

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

    const createdPackage = await writeFileSafe(
      join(root, "package.json"),
      packageTemplate(toPackageName(basename(root)), getBlumeVersion())
    );
    await writeFileSafe(join(root, "blume.config.ts"), CONFIG_TEMPLATE);
    await writeFileSafe(join(root, contentDir, "index.mdx"), INDEX_TEMPLATE);

    const nextSteps = createdPackage
      ? "Next steps:\n\n  npm install\n  blume dev\n"
      : "Next steps:\n\n  blume dev\n";
    logger.box(nextSteps);
  },
});
