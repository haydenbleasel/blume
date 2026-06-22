import { mkdir, readFile, writeFile } from "node:fs/promises";

import { dirname, join } from "pathe";

import type { BlumeProject } from "../core/project-graph.ts";
import {
  astroConfigTemplate,
  catchAllPageTemplate,
  contentConfigTemplate,
  envTemplate,
  runtimePackageTemplate,
  runtimeTsconfigTemplate,
} from "./templates.ts";

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
const buildRuntimeData = (project: BlumeProject): string => {
  const { config, graph, manifest } = project;
  const data = {
    config: {
      description: config.description,
      logo: config.logo ?? null,
      theme: config.theme,
      title: config.title,
    },
    navigation: graph.navigation,
    routes: manifest.routes.map((route) => ({
      draft: route.draft,
      hidden: route.hidden,
      id: route.id,
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

  const structural = await Promise.all([
    writeIfChanged(
      join(out, "astro.config.mjs"),
      astroConfigTemplate({ config, context, needsReact: false })
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
      catchAllPageTemplate()
    ),
  ]);

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
