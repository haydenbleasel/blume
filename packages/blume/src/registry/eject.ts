import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { join, relative } from "pathe";

import { resolveAskBackend } from "../ai/ask.ts";
import { buildRawMarkdown } from "../ai/markdown.ts";
import {
  buildRuntimeData,
  collectStaged,
  detectNeedsReact,
} from "../astro/generate.ts";
import { discoverPages } from "../astro/pages.ts";
import {
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  contentConfigTemplate,
  envTemplate,
  mixedbreadSearchEndpointTemplate,
  ogEndpointTemplate,
  rawMarkdownEndpointTemplate,
  rssEndpointTemplate,
  runtimeTsconfigTemplate,
  searchClientTemplate,
  searchEndpointTemplate,
  userComponentsTemplate,
} from "../astro/templates.ts";
import { scanProject } from "../core/project-graph.ts";
import type { ProjectContext } from "../core/types.ts";
import { buildRssFeeds, renderRssFeed } from "../deploy/rss.ts";
import { buildReferenceFiles, hasReferences } from "../openapi/scalar.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import { servesStaticIndex } from "../search/providers.ts";
import { tailwindEntryTemplate } from "../theme/entry.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { twoslashCss } from "../theme/twoslash.ts";

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
  const exportPdf = config.export.pdf;
  const exportEpub = config.export.epub;

  const [pages, needsReactRaw, userTheme, rawMarkdown] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(root),
    context.themeFile
      ? readFile(context.themeFile, "utf-8")
      : Promise.resolve(""),
    buildRawMarkdown(project),
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

  // Non-filesystem sources eject their materialized MDX into `<root>/blume-staged`
  // (a dedicated dir so it never clashes with a content root literally named
  // `content`; the relative `staged` collection points there).
  const staged = collectStaged(project);
  const hasStaged = staged.size > 0;
  const stagedDir = "blume-staged";

  const files: { path: string; content: string }[] = [
    {
      content: astroConfigTemplate({
        config,
        contentRoutes: project.manifest.routes.map((route) => route.path),
        context: relContext,
        dataPath: "./src/generated/data.json",
        needsReact,
        pages: relPages,
        searchClientPath: "./src/generated/search-client.ts",
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
        mathEnabled: config.markdown.math,
      }),
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
        twoslashCss: twoslashCss(),
        userTheme,
      }),
      path: join(genDir, "app.css"),
    },
    { content: buildRuntimeData(project), path: join(genDir, "data.json") },
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
    files.push({
      content: askEndpointTemplate(resolveAskBackend(config.ai.ask)),
      path: join(srcDir, "pages", "api", "ask.ts"),
    });
  }

  if (config.seo.og.enabled) {
    files.push({
      content: ogEndpointTemplate(),
      path: join(srcDir, "pages", "og", "[...slug].png.ts"),
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
  if (hasReferences(config)) {
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

  // Materialize staged source bodies under `<root>/blume-staged/<source>/<ref>`,
  // matching the relative `staged` collection base in the ejected config.
  for (const [entryId, content] of staged) {
    files.push({ content, path: join(root, stagedDir, entryId) });
  }

  await Promise.all(
    files.map(async (file) => {
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

  return files.map((file) => file.path);
};
