import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { join, relative } from "pathe";

import { buildRuntimeData, detectNeedsReact } from "../astro/generate.ts";
import { discoverPages } from "../astro/pages.ts";
import {
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  contentConfigTemplate,
  envTemplate,
  ogEndpointTemplate,
  runtimeTsconfigTemplate,
  searchEndpointTemplate,
  userComponentsTemplate,
} from "../astro/templates.ts";
import { scanProject } from "../core/project-graph.ts";
import type { ProjectContext } from "../core/types.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import { tailwindEntryTemplate } from "../theme/entry.ts";
import { buildThemeCss } from "../theme/palette.ts";

const POSIX = (path: string): string => path.split("\\").join("/");

/**
 * Promote the generated runtime into the project as an owned Astro app. After
 * eject the project has a normal `astro.config.mjs` and `src/`, the `blume` CLI
 * is no longer required, and the `blume` package remains importable.
 *
 * Returns the list of written files.
 */
export const eject = async (root: string): Promise<string[]> => {
  const project = await scanProject(root, { mode: "build" });
  const { context, config } = project;

  const srcDir = join(root, "src");
  const genDir = join(srcDir, "generated");
  const askEnabled = config.ai.ask?.enabled ?? false;

  const [pages, needsReactRaw, userTheme] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(root),
    context.themeFile
      ? readFile(context.themeFile, "utf-8")
      : Promise.resolve(""),
  ]);
  const needsReact = needsReactRaw || askEnabled;

  // A project-relative context so generated files use portable paths.
  const relContext: ProjectContext = {
    ...context,
    contentRoot: POSIX(relative(root, context.contentRoot)),
    outDir: ".",
    root: ".",
  };

  const componentsImport = context.componentsFile
    ? `../../${POSIX(relative(root, context.componentsFile))}`
    : null;
  const relPages = pages.map((page) => ({
    entrypoint: POSIX(relative(root, page.entrypoint)),
    pattern: page.pattern,
  }));

  const files: { path: string; content: string }[] = [
    {
      content: astroConfigTemplate({
        config,
        context: relContext,
        dataPath: "./src/generated/data.json",
        needsReact,
        pages: relPages,
        themePath: "./src/generated/app.css",
      }),
      path: join(root, "astro.config.mjs"),
    },
    {
      content: runtimeTsconfigTemplate(),
      path: join(root, "tsconfig.json"),
    },
    { content: envTemplate(), path: join(srcDir, "env.d.ts") },
    {
      content: contentConfigTemplate({ config, context: relContext }),
      path: join(srcDir, "content.config.ts"),
    },
    {
      content: catchAllPageTemplate({ askEnabled }),
      path: join(srcDir, "pages", "[...slug].astro"),
    },
    {
      content: userComponentsTemplate(componentsImport),
      path: join(genDir, "components.ts"),
    },
    {
      content: tailwindEntryTemplate({
        configTokens: buildThemeCss(config.theme),
        // Relative paths from src/generated/app.css keep the ejected app portable.
        sources: [
          "../../node_modules/blume/src/**/*.{astro,ts,tsx}",
          "../../**/*.{astro,mdx,ts,tsx}",
        ],
        userTheme,
      }),
      path: join(genDir, "app.css"),
    },
    { content: buildRuntimeData(project), path: join(genDir, "data.json") },
  ];

  if (askEnabled) {
    files.push({
      content: askEndpointTemplate(
        config.ai.ask?.model ?? "openai/gpt-4.1-mini"
      ),
      path: join(srcDir, "pages", "api", "ask.ts"),
    });
  }

  if (config.og.enabled) {
    files.push({
      content: ogEndpointTemplate(),
      path: join(srcDir, "pages", "og", "[...slug].png.ts"),
    });
  }

  if (config.search.provider === "orama") {
    const documents = await buildSearchDocuments(project);
    files.push(
      {
        content: `${JSON.stringify(documents)}\n`,
        path: join(genDir, "search.json"),
      },
      {
        content: searchEndpointTemplate(),
        path: join(srcDir, "pages", "blume-search.json.ts"),
      }
    );
  }

  await Promise.all(
    files.map(async (file) => {
      await mkdir(join(file.path, ".."), { recursive: true });
      await writeFile(file.path, file.content, "utf-8");
    })
  );

  // The hidden runtime is no longer the source of truth.
  await rm(context.outDir, { force: true, recursive: true });

  return files.map((file) => file.path);
};
