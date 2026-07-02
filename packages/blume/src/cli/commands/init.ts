import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { defineCommand } from "citty";
import { basename, dirname, isAbsolute, join, relative } from "pathe";

import { getBlumeVersion } from "../../core/version.ts";
import { eject } from "../../registry/eject.ts";
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

const TEMPLATES = ["docs", "api", "sdk", "changelog"] as const;
type Template = (typeof TEMPLATES)[number];

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** A starter: the config plus seed content files (path is relative to root). */
interface Starter {
  config: string;
  files: (contentDir: string) => { content: string; path: string }[];
}

const configFor = (
  extra: string
): string => `import { defineConfig } from "blume";

export default defineConfig({
  title: "My Docs",
  description: "Documentation powered by Blume.",${extra}
});
`;

const page = (title: string, description: string, body: string): string =>
  `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`;

const STARTERS: Record<Template, Starter> = {
  api: {
    config: configFor(`
  openapi: {
    enabled: true,
    route: "/api",
    sources: [
      {
        label: "Petstore",
        spec: "https://petstore3.swagger.io/api/v3/openapi.json",
      },
    ],
  },`),
    files: (dir) => [
      {
        content: page(
          "API Reference",
          "Explore the API.",
          "# API Reference\n\nYour OpenAPI spec renders at [`/api`](/api). Point `openapi.sources` at your own spec in `blume.config.ts`."
        ),
        path: join(dir, "index.mdx"),
      },
    ],
  },
  changelog: {
    config: configFor(`
  navigation: {
    tabs: [
      { label: "Docs", path: "/" },
      { label: "Changelog", path: "/changelog" },
    ],
  },`),
    files: (dir) => [
      {
        content: page(
          "Introduction",
          "Welcome to your new Blume docs.",
          "# Introduction\n\nWrite your docs here, and log releases under `changelog/`."
        ),
        path: join(dir, "index.mdx"),
      },
      {
        content: `---\ntitle: v1.0.0\ntype: changelog\ndate: 2026-01-01\n---\n\nThe first release. Edit \`${dir}/changelog/v1-0-0.mdx\` or add new entries beside it.\n`,
        path: join(dir, "changelog", "v1-0-0.mdx"),
      },
    ],
  },
  docs: {
    config: configFor(""),
    files: (dir) => [
      {
        content: page(
          "Introduction",
          "Welcome to your new Blume docs.",
          `# Introduction\n\nWelcome to **Blume** — markdown-first docs powered by Astro and Vite.\n\nEdit \`${dir}/index.mdx\` to get started, then run \`blume dev\`.`
        ),
        path: join(dir, "index.mdx"),
      },
    ],
  },
  sdk: {
    config: configFor(""),
    files: (dir) => [
      {
        content: page(
          "Introduction",
          "Get started with the SDK.",
          "# Introduction\n\nInstall the SDK and make your first call. See [Installation](/installation)."
        ),
        path: join(dir, "index.mdx"),
      },
      {
        content: page(
          "Installation",
          "Install the SDK.",
          "# Installation\n\n```package-install\nyour-sdk\n```"
        ),
        path: join(dir, "installation.mdx"),
      },
    ],
  },
};

/** Install + dev commands to print for the chosen package manager. */
const commandsFor = (pm: PackageManager): { dev: string; install: string } => ({
  dev: pm === "npm" ? "npm run dev" : `${pm} dev`,
  install: `${pm} install`,
});

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
    eject: {
      description: "Eject to a standalone Astro project after scaffolding.",
      type: "boolean",
    },
    "package-manager": {
      description:
        "Package manager for the next-steps hint (npm|pnpm|yarn|bun).",
      type: "string",
    },
    template: {
      description: "Starter template: docs | api | sdk | changelog.",
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
    // The content dir is joined into every scaffolded file path, so an absolute
    // or `../`-escaping value would write outside the project. Reject it.
    if (
      isAbsolute(contentDir) ||
      relative(root, join(root, contentDir)).startsWith("..")
    ) {
      logger.error(
        `Invalid --content-dir "${contentDir}" (must be a path inside the project).`
      );
      process.exit(1);
    }

    const template = (args.template ?? "docs") as Template;
    if (!TEMPLATES.includes(template)) {
      logger.error(
        `Unknown template "${args.template}" (use ${TEMPLATES.join(" | ")}).`
      );
      process.exit(1);
    }
    const pm = (args["package-manager"] ?? "npm") as PackageManager;
    if (!PACKAGE_MANAGERS.includes(pm)) {
      logger.error(
        `Unknown package manager "${args["package-manager"]}" (use ${PACKAGE_MANAGERS.join(" | ")}).`
      );
      process.exit(1);
    }

    const starter = STARTERS[template];
    const createdPackage = await writeFileSafe(
      join(root, "package.json"),
      packageTemplate(toPackageName(basename(root)), getBlumeVersion())
    );
    await writeFileSafe(join(root, "blume.config.ts"), starter.config);
    await Promise.all(
      starter
        .files(contentDir)
        .map((file) => writeFileSafe(join(root, file.path), file.content))
    );

    const commands = commandsFor(pm);

    if (args.eject) {
      // Eject only generates files (no Astro runtime), so it works right after
      // scaffolding. The standalone app then runs with Astro directly.
      try {
        await eject(root);
        logger.success("Ejected to a standalone Astro project.");
        logger.box(`Next steps:\n\n  ${commands.install}\n  npx astro dev\n`);
      } catch (error) {
        logger.warn(
          `Scaffolded, but eject failed: ${(error as Error).message}`
        );
        logger.box(
          `Next steps:\n\n  ${commands.install}\n  blume eject --yes\n`
        );
      }
      return;
    }

    const nextSteps = createdPackage
      ? `Next steps:\n\n  ${commands.install}\n  ${commands.dev}\n`
      : `Next steps:\n\n  ${commands.dev}\n`;
    logger.box(nextSteps);
  },
});
