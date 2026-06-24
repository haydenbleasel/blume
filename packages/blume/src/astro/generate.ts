import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dirname, join, relative } from "pathe";
import { glob } from "tinyglobby";

import { writeLlmsArtifacts } from "../ai/llms.ts";
import {
  buildPageMarkdown,
  buildRawMarkdown,
  isPublicAgentPage,
} from "../ai/markdown.ts";
import { writeChangelogRssFeeds } from "../changelog/rss.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { PageRecord } from "../core/types.ts";
import { buildSearchDocuments } from "../search/documents.ts";
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
  rawMarkdownEndpointTemplate,
  runtimeDependencies,
  runtimePackageTemplate,
  runtimeTsconfigTemplate,
  searchEndpointTemplate,
  userComponentsTemplate,
} from "./templates.ts";

/** Absolute path to the Blume package `src` directory. */
const BLUME_SRC = fileURLToPath(new URL("..", import.meta.url));
/** The Blume package's own `node_modules` (where Astro and friends live). */
const BLUME_NODE_MODULES = join(BLUME_SRC, "..", "node_modules");

/** Whether Astro resolves from a directory via normal node resolution. */
const canResolveAstro = (fromDir: string): boolean => {
  try {
    createRequire(pathToFileURL(join(fromDir, "_.js")).href).resolve(
      "astro/package.json"
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Make the generated runtime resolve Astro and its integrations. When they are
 * hoisted into the project (the usual case for published installs), resolution
 * already works. When they are nested and unreachable (workspaces, strict
 * package managers), symlink Blume's own dependencies into `.blume`.
 */
const ensureDepsLink = async (outDir: string): Promise<void> => {
  if (canResolveAstro(outDir)) {
    return;
  }
  if (!existsSync(join(BLUME_NODE_MODULES, "astro"))) {
    return;
  }
  const link = join(outDir, "node_modules");
  if (existsSync(link)) {
    return;
  }
  await mkdir(outDir, { recursive: true });
  await symlink(BLUME_NODE_MODULES, link, "junction");
};

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

const readThemeFiles = async (paths: string[]): Promise<string> => {
  const contents = await Promise.all(paths.map((path) => readOptional(path)));
  return contents.filter((content) => content.length > 0).join("\n");
};

const copyIfExists = async (from: string, to: string): Promise<void> => {
  if (!existsSync(from)) {
    return;
  }
  await cp(from, to, { force: true, recursive: true });
};

const mintlifyStaticCandidates = [
  "assets",
  "files",
  "fonts",
  "images",
  "img",
  "logo",
  "logos",
  "videos",
  "favicon.ico",
  "favicon.png",
  "favicon.svg",
  "robots.txt",
];

const preparePublicAssets = async (project: BlumeProject): Promise<void> => {
  const { context } = project;
  const sourcePublic = join(context.root, "public");
  if (context.publicRoot === sourcePublic) {
    return;
  }

  await rm(context.publicRoot, { force: true, recursive: true });
  await mkdir(context.publicRoot, { recursive: true });
  await copyIfExists(sourcePublic, context.publicRoot);

  if (context.configFile?.endsWith("docs.json") !== true) {
    return;
  }

  await Promise.all(
    mintlifyStaticCandidates.map((candidate) =>
      copyIfExists(
        join(context.root, candidate),
        join(context.publicRoot, candidate)
      )
    )
  );
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

const MERMAID_FENCE = /^```mermaid(?:\s|$)/mu;

export const detectNeedsMermaid = async (
  pages: PageRecord[]
): Promise<boolean> => {
  const sources = await Promise.all(
    pages
      .filter((page) => page.format === "mdx")
      .map((page) => readFile(page.sourcePath, "utf-8"))
  );
  return sources.some((source) => MERMAID_FENCE.test(source));
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
  // Write to a temp file then atomically rename into place, so a watching dev
  // server never observes a missing or half-written file mid-regeneration.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf-8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return true;
};

/** Serialize the content graph into the data module the runtime consumes. */
export const buildRuntimeData = (project: BlumeProject): string => {
  const { config, context, graph, manifest } = project;
  const { github } = config;
  const repoUrl = github
    ? `https://github.com/${github.owner}/${github.repo}`
    : null;
  const editBase = github ? `${repoUrl}/edit/${github.branch}` : null;
  const editUrlFor = (sourcePath: string): string | null => {
    if (!editBase) {
      return null;
    }
    const rel = relative(context.root, sourcePath).split("\\").join("/");
    return `${editBase}/${github?.dir ? `${github.dir}/${rel}` : rel}`;
  };

  const data = {
    config: {
      banner: config.banner ?? null,
      contextual: config.contextual,
      description: config.description,
      favicon: config.favicon ?? null,
      footer: config.footer,
      logo: config.logo ?? null,
      navbar: config.navbar,
      og: { enabled: config.og.enabled },
      repoUrl,
      search: {
        enabled: config.search.provider !== "none",
        prompt: config.search.prompt,
        provider: config.search.provider,
      },
      seo: config.seo,
      site: config.deployment.site ?? null,
      styling: config.styling,
      theme: config.theme,
      title: config.title,
    },
    navigation: graph.navigation,
    routes: manifest.routes.map((route) => ({
      draft: route.draft,
      editUrl: editUrlFor(route.sourcePath),
      hidden: route.hidden,
      id: route.id,
      indexable: route.indexable,
      path: route.path,
      title: route.title,
    })),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
};

/** Serialize route -> Markdown export content for Accept-header routing. */
export const buildRuntimeMarkdown = async (
  project: BlumeProject
): Promise<string> => {
  if (!project.config.ai.llmsTxt) {
    return "{}\n";
  }

  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));
  const entries = await Promise.all(
    project.manifest.routes
      .filter((route) => {
        const page = pageById.get(route.id);
        return route.indexable && page !== undefined && isPublicAgentPage(page);
      })
      .map(async (route) => {
        const page = pageById.get(route.id);
        return page ? [route.path, await buildPageMarkdown(project, page)] : [];
      })
  );
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
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
  const markdownDataPath = join(srcDir, "generated", "markdown.json");
  const themePath = join(srcDir, "generated", "app.css");

  await ensureDepsLink(out);
  await preparePublicAssets(project);
  if (context.publicRoot !== join(context.root, "public")) {
    await writeChangelogRssFeeds(project, context.publicRoot);
  }
  await rm(join(srcDir, "middleware.ts"), { force: true });
  if (
    config.ai.llmsTxt &&
    context.publicRoot !== join(context.root, "public")
  ) {
    await writeLlmsArtifacts(project, context.publicRoot);
  }

  const askEnabled = config.ai.ask?.enabled ?? false;
  const [pages, detectedReact, detectedMermaid, userTheme] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(context.root),
    detectNeedsMermaid(project.graph.pages),
    readThemeFiles(context.themeFiles),
  ]);
  const needsReact = detectedReact || askEnabled;

  await writeIfChanged(markdownDataPath, await buildRuntimeMarkdown(project));

  const structural = await Promise.all([
    writeIfChanged(
      join(out, "astro.config.mjs"),
      astroConfigTemplate({
        config,
        context,
        dataPath,
        markdownDataPath,
        needsReact,
        pages,
        themePath,
      })
    ),
    writeIfChanged(
      join(out, "package.json"),
      runtimePackageTemplate(runtimeDependencies({ config, needsReact }))
    ),
    writeIfChanged(join(out, "tsconfig.json"), runtimeTsconfigTemplate()),
    writeIfChanged(join(srcDir, "env.d.ts"), envTemplate()),
    writeIfChanged(
      join(srcDir, "content.config.ts"),
      contentConfigTemplate({ config, context })
    ),
    writeIfChanged(
      join(srcDir, "pages", "[...slug].astro"),
      catchAllPageTemplate({
        askEnabled,
        mathEnabled: config.markdown.math,
        mermaidEnabled: detectedMermaid,
      })
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
      askEndpointTemplate(config.ai.ask?.model ?? "openai/gpt-5.5")
    );
  }

  await rm(join(srcDir, "pages", "api", "blume", "proxy.ts"), {
    force: true,
  });

  if (config.og.enabled) {
    await writeIfChanged(
      join(srcDir, "pages", "og", "[...slug].png.ts"),
      ogEndpointTemplate()
    );
  }

  if (config.search.provider === "orama") {
    const documents = await buildSearchDocuments(project);
    await writeIfChanged(
      join(srcDir, "generated", "search.json"),
      `${JSON.stringify(documents)}\n`
    );
    await writeIfChanged(
      join(srcDir, "pages", "blume-search.json.ts"),
      searchEndpointTemplate()
    );
  }

  const rawMarkdown = await buildRawMarkdown(project);
  await Promise.all([
    writeIfChanged(
      join(srcDir, "generated", "raw-markdown.json"),
      `${JSON.stringify(rawMarkdown)}\n`
    ),
    writeIfChanged(
      join(srcDir, "pages", "[...slug].md.ts"),
      rawMarkdownEndpointTemplate()
    ),
    writeIfChanged(
      join(srcDir, "pages", "[...slug].mdx.ts"),
      rawMarkdownEndpointTemplate()
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
