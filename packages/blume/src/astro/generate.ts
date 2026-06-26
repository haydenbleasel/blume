import { existsSync, readFileSync } from "node:fs";
import {
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

import { buildRawMarkdown } from "../ai/markdown.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { buildRssFeeds, renderRssFeed } from "../deploy/rss.ts";
import {
  buildReferenceFiles,
  hasReferences,
  referenceTabs,
} from "../openapi/scalar.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import { tailwindEntryTemplate } from "../theme/entry.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { discoverPages } from "./pages.ts";
import {
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  changelogIndexTemplate,
  contentConfigTemplate,
  envTemplate,
  ogEndpointTemplate,
  rawMarkdownEndpointTemplate,
  rssEndpointTemplate,
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

/** The logo shape the runtime consumes: an inline SVG or image URL(s). */
interface ResolvedLogo {
  svg?: string;
  light?: string;
  dark?: string;
  alt: string;
  href: string;
}

/**
 * Resolve the configured logo. A single SVG is read and inlined so a
 * `currentColor` logo follows the theme; other images keep their URL for an
 * `<img>`. The file is looked up under `public/` and the project root.
 */
const resolveLogo = (project: BlumeProject): ResolvedLogo | null => {
  const { logo } = project.config;
  if (!logo) {
    return null;
  }
  const config = typeof logo === "string" ? { light: logo } : logo;
  const light = config.light ?? config.dark;
  const dark = config.dark ?? config.light;
  const alt = config.alt ?? "";
  const href = config.href ?? "/";

  if (light && light === dark && light.toLowerCase().endsWith(".svg")) {
    const rel = light.replace(/^\//u, "");
    const file = [
      join(project.context.root, "public", rel),
      join(project.context.root, rel),
    ].find((path) => existsSync(path));
    if (file) {
      return { alt, href, svg: readFileSync(file, "utf-8") };
    }
  }
  return { alt, dark, href, light };
};

/** The announcement banner shape the runtime consumes. */
interface ResolvedBanner {
  content: string;
  link?: { href: string; text: string };
  dismissible: boolean;
  /** Dismissal key: the configured id, else the content itself. */
  key: string;
}

/** Normalize the banner config (string shorthand or object) for the runtime. */
const resolveBanner = (config: ResolvedConfig): ResolvedBanner | null => {
  const { banner } = config;
  if (!banner) {
    return null;
  }
  if (typeof banner === "string") {
    return { content: banner, dismissible: false, key: banner };
  }
  return {
    content: banner.content,
    dismissible: banner.dismissible,
    key: banner.id ?? banner.content,
    link: banner.link,
  };
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
      banner: resolveBanner(config),
      description: config.description,
      imageZoom: config.markdown.imageZoom,
      logo: resolveLogo(project),
      og: { enabled: config.seo.og.enabled },
      repoUrl,
      search: {
        enabled: config.search.provider !== "none",
        provider: config.search.provider,
      },
      site: config.deployment.site ?? null,
      structuredData: config.seo.structuredData,
      theme: config.theme,
      title: config.title,
    },
    feeds: buildRssFeeds(project).map((feed) => ({
      href: feed.path,
      title: feed.title,
    })),
    // API reference routes (Scalar) surface as header tabs alongside the
    // content-derived ones, so the reference stays discoverable.
    navigation: {
      ...graph.navigation,
      tabs: [...graph.navigation.tabs, ...referenceTabs(config)],
    },
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

export interface GenerateResult {
  /** Whether any structural file changed (config/page/content config). */
  structuralChange: boolean;
  /** Non-fatal warnings raised while generating (e.g. a missing API spec). */
  warnings: string[];
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

  await ensureDepsLink(out);

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
      catchAllPageTemplate({ askEnabled, mathEnabled: config.markdown.math })
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

  if (config.seo.og.enabled) {
    await writeIfChanged(
      join(srcDir, "pages", "og", "[...slug].png.ts"),
      ogEndpointTemplate()
    );
  }

  // Changelog index (`/changelog`): a timeline of every `type: changelog` entry,
  // rendered through the Update layout. Skipped when there are no entries, or
  // when a user content page already occupies the `/changelog` route.
  const hasChangelog = project.graph.pages.some(
    (page) =>
      page.contentType === "changelog" &&
      !(page.meta.draft || page.meta.sidebar.hidden)
  );
  const changelogRouteTaken = project.graph.pages.some(
    (page) => page.route === "/changelog"
  );
  if (hasChangelog && !changelogRouteTaken) {
    await writeIfChanged(
      join(srcDir, "pages", "changelog.astro"),
      changelogIndexTemplate({ askEnabled })
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

  // Automatic RSS feeds for blog/changelog content types (a no-op when no such
  // pages exist or no deployment.site is configured).
  const feeds = buildRssFeeds(project);
  if (feeds.length > 0) {
    const feedXml = Object.fromEntries(
      feeds.map((feed) => [feed.type, renderRssFeed(feed)])
    );
    await Promise.all([
      writeIfChanged(
        join(srcDir, "generated", "rss.json"),
        `${JSON.stringify(feedXml)}\n`
      ),
      writeIfChanged(
        join(srcDir, "pages", "[section]", "rss.xml.ts"),
        rssEndpointTemplate()
      ),
    ]);
  }

  // API/AsyncAPI reference pages (Scalar). One self-contained page per source,
  // mounted on its configured route and regenerated each run.
  const warnings: string[] = [];
  if (hasReferences(config)) {
    const references = await buildReferenceFiles({
      config,
      contentRoutes: new Set(project.graph.pages.map((page) => page.route)),
      root: context.root,
    });
    warnings.push(...references.warnings);
    await Promise.all(
      references.files.map((file) =>
        writeIfChanged(join(srcDir, "pages", file.pagePath), file.content)
      )
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

  return { structuralChange: structural.some(Boolean), warnings };
};
