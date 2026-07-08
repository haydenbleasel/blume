import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { join, relative } from "pathe";

import { buildAskData } from "../ai/ask-data.ts";
import { resolveAskBackend } from "../ai/ask.ts";
import { buildRawMarkdown } from "../ai/markdown.ts";
import { planComponentSlots } from "../astro/component-slots.ts";
import { discoverExamples } from "../astro/examples.ts";
import {
  buildRuntimeData,
  collectStaged,
  detectNeedsReact,
  detectUsesMath,
} from "../astro/generate.ts";
import { discoverIslands } from "../astro/islands.ts";
import { customOgRoutes, discoverPages, routeIsTaken } from "../astro/pages.ts";
import {
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  contentConfigTemplate,
  envTemplate,
  exampleMapTemplate,
  exampleWrapperTemplate,
  examplesPageTemplate,
  exampleSlug,
  islandMapTemplate,
  islandWrapperTemplate,
  mixedbreadSearchEndpointTemplate,
  notFoundPageTemplate,
  ogEndpointTemplate,
  rawMarkdownEndpointTemplate,
  rssEndpointTemplate,
  runtimeTsconfigTemplate,
  searchClientTemplate,
  searchEndpointTemplate,
} from "../astro/templates.ts";
import { scanProject } from "../core/project-graph.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ProjectContext } from "../core/types.ts";
import { buildRssFeeds, renderRssFeed } from "../deploy/rss.ts";
import { hasScalarReferences } from "../openapi/references.ts";
import { buildReferenceFiles } from "../openapi/scalar.ts";
import { isOpenApiSource } from "../openapi/source.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import { servesStaticIndex } from "../search/providers.ts";
import {
  examplesEntryTemplate,
  tailwindEntryTemplate,
} from "../theme/entry.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { twoslashCss } from "../theme/twoslash.ts";

const toPosix = (path: string): string => path.split("\\").join("/");

/** The `blume:openapi` payload for the ejected app (`{}` when none). */
const ejectOpenApiData = (project: BlumeProject): unknown => {
  const source = project.sources.find(isOpenApiSource);
  return source ? source.openApiData() : {};
};

/**
 * The Ask AI endpoint plus, unless the backend runs its own retrieval (Inkeep),
 * its grounding snapshot. Empty when Ask AI is disabled.
 */
const askFiles = async (
  project: BlumeProject,
  srcDir: string,
  genDir: string
): Promise<{ content: string; path: string }[]> => {
  const { ask } = project.config.ai;
  if (!ask?.enabled) {
    return [];
  }
  const grounded = ask.provider !== "inkeep";
  const files = [
    {
      content: askEndpointTemplate(resolveAskBackend(ask), grounded),
      path: join(srcDir, "pages", "api", "ask.ts"),
    },
  ];
  if (grounded) {
    files.push({
      content: `${JSON.stringify(await buildAskData(project))}\n`,
      path: join(genDir, "ask-data.json"),
    });
  }
  return files;
};

/** Contents of the configured `examples.css`, or `""` when unset/absent. */
const readExamplesCss = (
  root: string,
  css: string | undefined
): Promise<string> =>
  css && existsSync(join(root, css))
    ? readFile(join(root, css), "utf-8")
    : Promise.resolve("");

/**
 * The per-example preview route `<Component />` iframes embed, nested under
 * `basePath` so it stays reachable behind a proxy that only forwards the
 * base. Empty when the project has no examples.
 */
const examplesPreviewFiles = (
  srcDir: string,
  basePath: string,
  hasExamples: boolean
): { content: string; path: string }[] =>
  hasExamples
    ? [
        {
          content: examplesPageTemplate(),
          path: join(
            srcDir,
            "pages",
            ...basePath.split("/").filter(Boolean),
            "blume-examples",
            "[...path].astro"
          ),
        },
      ]
    : [];

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
  const exportPdf = config.export.pdf;
  const exportEpub = config.export.epub;

  const [
    pages,
    needsReactRaw,
    usesMath,
    userTheme,
    userExamplesCss,
    rawMarkdown,
    islands,
    examples,
  ] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(root),
    detectUsesMath(root),
    context.themeFile
      ? readFile(context.themeFile, "utf-8")
      : Promise.resolve(""),
    readExamplesCss(root, config.examples.css),
    buildRawMarkdown(project),
    discoverIslands(root),
    discoverExamples(root, config.examples.source),
  ]);
  // Island/example frameworks drive which Astro renderers the ejected config
  // wires in; React also switches on for project `.tsx`/`.jsx` and Ask AI.
  const frameworks = new Set<string>([
    ...islands.islands.map((island) => island.framework),
    ...examples.examples.map((example) => example.framework),
  ]);
  const needsReact = needsReactRaw || askEnabled || frameworks.has("react");
  const needsVue = frameworks.has("vue");
  const needsSvelte = frameworks.has("svelte");

  // A project-relative context so generated files use portable paths.
  const relContext: ProjectContext = {
    ...context,
    contentRoot: toPosix(relative(root, context.contentRoot)),
    outDir: ".",
    root: ".",
  };

  const componentsImport = context.componentsFile
    ? `../../${toPosix(relative(root, context.componentsFile))}`
    : null;
  const relPages = pages.map((page) => ({
    entrypoint: toPosix(relative(root, page.entrypoint)),
    pattern: page.pattern,
  }));

  // Non-filesystem sources eject their materialized MDX into `<root>/blume-staged`
  // (a dedicated dir so it never clashes with a content root literally named
  // `content`; the relative `staged` collection points there).
  const staged = collectStaged(project);
  const hasStaged = staged.size > 0;
  const stagedDir = "blume-staged";

  const files: {
    path: string;
    content: string;
    /** Don't overwrite a file the user already owns (e.g. a tuned tsconfig). */
    skipIfExists?: boolean;
  }[] = [
    {
      content: astroConfigTemplate({
        config,
        contentRoutes: project.manifest.routes.map((route) => route.path),
        context: relContext,
        dataPath: "./src/generated/data.json",
        examplesPath: "./src/generated/examples.ts",
        examplesThemePath: "./src/generated/examples.css",
        needsReact,
        needsSvelte,
        needsVue,
        openapiPath: "./src/generated/openapi.json",
        pages: relPages,
        searchClientPath: "./src/generated/search-client.ts",
        themePath: "./src/generated/app.css",
      }),
      path: join(root, "astro.config.mjs"),
    },
    {
      content: runtimeTsconfigTemplate(),
      path: join(root, "tsconfig.json"),
      // Never clobber a hand-tuned tsconfig; only write ours if none exists.
      skipIfExists: true,
    },
    { content: envTemplate(), path: join(srcDir, "env.d.ts") },
    {
      content: contentConfigTemplate({
        config,
        context: relContext,
        staged: hasStaged,
        stagedBase: stagedDir,
      }),
      path: join(srcDir, "content.config.ts"),
    },
    {
      content: catchAllPageTemplate({
        askEnabled,
        exportEpub,
        exportPdf,
        mathEnabled: usesMath,
        needsReact,
      }),
      path: join(srcDir, "pages", "[...slug].astro"),
    },
    {
      // Eject keeps the portable re-export form (relative import to the user's
      // components file); hydration/island wrappers would need machine-specific
      // absolute paths, so the ejected app owns and wires those itself.
      content: planComponentSlots(componentsImport, null).module,
      path: join(genDir, "components.ts"),
    },
    // Island/example maps the catch-all imports; written even when empty so the
    // relative import and the `blume:examples` alias always resolve.
    {
      content: islandMapTemplate(islands.islands),
      path: join(genDir, "islands.ts"),
    },
    {
      content: exampleMapTemplate(examples.examples, config.basePath),
      path: join(genDir, "examples.ts"),
    },
    {
      // The isolated Tailwind entry for `<Component />` preview frames.
      // Relative sources keep the ejected app portable.
      content: examplesEntryTemplate({
        configTokens: buildThemeCss(config.theme),
        sources: ["../../**/*.{astro,jsx,svelte,ts,tsx,vue}"],
        userCss: userExamplesCss,
      }),
      path: join(genDir, "examples.css"),
    },
    {
      content: tailwindEntryTemplate({
        configTokens: buildThemeCss(config.theme),
        // Relative paths from src/generated/app.css keep the ejected app portable.
        sources: [
          "../../node_modules/blume/src/**/*.{astro,ts,tsx}",
          "../../**/*.{astro,mdx,ts,tsx}",
        ],
        twoslashCss: twoslashCss(),
        userTheme,
      }),
      path: join(genDir, "app.css"),
    },
    { content: buildRuntimeData(project), path: join(genDir, "data.json") },
    {
      content: `${JSON.stringify(ejectOpenApiData(project))}\n`,
      path: join(genDir, "openapi.json"),
    },
    {
      content: `${JSON.stringify(rawMarkdown)}\n`,
      path: join(genDir, "raw-markdown.json"),
    },
    {
      content: rawMarkdownEndpointTemplate(),
      path: join(srcDir, "pages", "[...slug].md.ts"),
    },
    {
      content: rawMarkdownEndpointTemplate(),
      path: join(srcDir, "pages", "[...slug].mdx.ts"),
    },
  ];

  if (askEnabled) {
    files.push(...(await askFiles(project, srcDir, genDir)));
  }

  if (config.seo.og.enabled) {
    files.push({
      content: ogEndpointTemplate(customOgRoutes(pages, config.title)),
      path: join(srcDir, "pages", "og", "[...slug].png.ts"),
    });
  }

  // Default 404 page, unless the project already owns `/404` (a custom
  // `pages/404.astro` or a `404.md` content page). The ejected project owns the
  // file afterwards and can edit or remove it.
  if (!routeIsTaken(pages, project.graph.pages, "/404")) {
    files.push({
      content: notFoundPageTemplate(),
      path: join(srcDir, "pages", "404.astro"),
    });
  }

  // The provider-specific client loader behind the `blume:search-client` alias.
  files.push({
    content: searchClientTemplate(config),
    path: join(genDir, "search-client.ts"),
  });

  if (servesStaticIndex(config.search.provider)) {
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

  if (config.search.provider === "mixedbread") {
    files.push({
      content: mixedbreadSearchEndpointTemplate(
        config.search.mixedbread?.storeId ?? ""
      ),
      path: join(srcDir, "pages", "api", "search.ts"),
    });
  }

  const feeds = buildRssFeeds(project);
  if (feeds.length > 0) {
    const feedXml = Object.fromEntries(
      feeds.map((feed) => [feed.type, renderRssFeed(feed)])
    );
    files.push(
      {
        content: `${JSON.stringify(feedXml)}\n`,
        path: join(genDir, "rss.json"),
      },
      {
        content: rssEndpointTemplate(),
        path: join(srcDir, "pages", "[section]", "rss.xml.ts"),
      }
    );
  }

  // Scalar API/AsyncAPI reference pages, mirrored from the generated runtime so
  // the ejected app keeps its reference routes.
  if (hasScalarReferences(config)) {
    const references = await buildReferenceFiles({
      config,
      contentRoutes: new Set(project.graph.pages.map((page) => page.route)),
      root,
    });
    for (const file of references.files) {
      files.push({
        content: file.content,
        path: join(srcDir, "pages", file.pagePath),
      });
    }
  }

  // Per-island and per-example live wrappers referenced by the maps above.
  files.push(
    ...islands.islands.map((island) => ({
      content: islandWrapperTemplate(island),
      path: join(genDir, "islands", `${island.name}.astro`),
    })),
    ...examples.examples.map((example) => ({
      content: exampleWrapperTemplate(example),
      path: join(genDir, "examples", `${exampleSlug(example.path)}.astro`),
    })),
    ...examplesPreviewFiles(
      srcDir,
      config.basePath,
      examples.examples.length > 0
    )
  );

  // Materialize staged source bodies under `<root>/blume-staged/<source>/<ref>`,
  // matching the relative `staged` collection base in the ejected config.
  for (const [entryId, content] of staged) {
    files.push({ content, path: join(root, stagedDir, entryId) });
  }

  const written = files.filter(
    (file) => !(file.skipIfExists && existsSync(file.path))
  );
  await Promise.all(
    written.map(async (file) => {
      await mkdir(join(file.path, ".."), { recursive: true });
      await writeFile(file.path, file.content, "utf-8");
    })
  );

  // Materialized source assets (e.g. downloaded Notion images) live under the
  // hidden runtime's public dir; copy them into the owned project's `public/`
  // so the staged content's `/blume-assets/…` references still resolve.
  const assetsSrc = join(context.outDir, "public", "blume-assets");
  if (existsSync(assetsSrc)) {
    await cp(assetsSrc, join(root, "public", "blume-assets"), {
      recursive: true,
    });
  }

  // The hidden runtime is no longer the source of truth.
  await rm(context.outDir, { force: true, recursive: true });

  return written.map((file) => file.path);
};
