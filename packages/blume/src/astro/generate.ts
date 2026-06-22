import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { dirname, join } from "pathe";
import { glob } from "tinyglobby";

import type { BlumeProject } from "../core/project-graph.ts";
import { tailwindEntryTemplate } from "../theme/entry.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { discoverPages } from "./pages.ts";
import {
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  contentConfigTemplate,
  envTemplate,
  ogEndpointTemplate,
  runtimePackageTemplate,
  runtimeTsconfigTemplate,
  userComponentsTemplate,
} from "./templates.ts";

/** Absolute path to the Blume package `src` directory. */
const BLUME_SRC = fileURLToPath(new URL("..", import.meta.url));

/** Read a file's contents, or return an empty string if it is absent. */
const readOptional = async (path: string | null): Promise<string> => {
  if (!path) {
    return "";
  }
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
};

/** Heuristically detect whether the project uses React islands. */
export const detectNeedsReact = async (root: string): Promise<boolean> => {
  const matches = await glob(["**/*.{tsx,jsx}"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/.blume/**", "**/dist/**"],
    onlyFiles: true,
  });
  return matches.length > 0;
};

const writeIfChanged = async (
  path: string,
  content: string
): Promise<boolean> => {
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    existing = null;
  }
  if (existing === content) {
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return true;
};

/** Serialize the content graph into the data module the runtime consumes. */
export const buildRuntimeData = (project: BlumeProject): string => {
  const { config, graph, manifest } = project;
  const data = {
    config: {
      description: config.description,
      logo: config.logo ?? null,
      og: { enabled: config.og.enabled },
      search: { enabled: config.search.provider !== "none" },
      site: config.deployment.site ?? null,
      theme: config.theme,
      title: config.title,
    },
    navigation: graph.navigation,
    routes: manifest.routes.map((route) => ({
      draft: route.draft,
      hidden: route.hidden,
      id: route.id,
      indexable: route.indexable,
      path: route.path,
      title: route.title,
    })),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
};

export interface GenerateResult {
  /** Whether any structural file changed (config/page/content config). */
  structuralChange: boolean;
}

/**
 * Write (or update) the generated `.blume/` Astro runtime for a project.
 * Only files whose content changed are rewritten so Vite HMR stays fast.
 */
export const generateRuntime = async (
  project: BlumeProject
): Promise<GenerateResult> => {
  const { context, config } = project;
  const out = context.outDir;
  const srcDir = join(out, "src");
  const dataPath = join(srcDir, "generated", "data.json");
  const themePath = join(srcDir, "generated", "app.css");

  const askEnabled = config.ai.ask?.enabled ?? false;
  const [pages, detectedReact, userTheme] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(context.root),
    readOptional(context.themeFile),
  ]);
  const needsReact = detectedReact || askEnabled;

  const structural = await Promise.all([
    writeIfChanged(
      join(out, "astro.config.mjs"),
      astroConfigTemplate({
        config,
        context,
        dataPath,
        needsReact,
        pages,
        themePath,
      })
    ),
    writeIfChanged(join(out, "package.json"), runtimePackageTemplate()),
    writeIfChanged(join(out, "tsconfig.json"), runtimeTsconfigTemplate()),
    writeIfChanged(join(srcDir, "env.d.ts"), envTemplate()),
    writeIfChanged(
      join(srcDir, "content.config.ts"),
      contentConfigTemplate({ config, context })
    ),
    writeIfChanged(
      join(srcDir, "pages", "[...slug].astro"),
      catchAllPageTemplate({ askEnabled })
    ),
    writeIfChanged(
      join(srcDir, "generated", "components.ts"),
      userComponentsTemplate(context.componentsFile)
    ),
    writeIfChanged(
      themePath,
      tailwindEntryTemplate({
        configTokens: buildThemeCss(config.theme),
        sources: [
          `${BLUME_SRC}/**/*.{astro,ts,tsx}`,
          `${context.root}/**/*.{astro,mdx,ts,tsx}`,
        ],
        userTheme,
      })
    ),
  ]);

  if (askEnabled) {
    await writeIfChanged(
      join(srcDir, "pages", "api", "ask.ts"),
      askEndpointTemplate(config.ai.ask?.model ?? "openai/gpt-4.1-mini")
    );
  }

  if (config.og.enabled) {
    await writeIfChanged(
      join(srcDir, "pages", "og", "[...slug].png.ts"),
      ogEndpointTemplate()
    );
  }

  // Data and manifest are not "structural" for Astro; they hot-reload.
  await writeIfChanged(
    join(srcDir, "generated", "data.json"),
    buildRuntimeData(project)
  );
  await writeIfChanged(
    join(out, "blume.manifest.json"),
    `${JSON.stringify(project.manifest, null, 2)}\n`
  );

  return { structuralChange: structural.some(Boolean) };
};
