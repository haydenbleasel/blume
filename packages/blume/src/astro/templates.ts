import { existsSync, readFileSync } from "node:fs";

import { dirname, join } from "pathe";

import type { ResolvedConfig } from "../core/schema.ts";
import type { ProjectContext } from "../core/types.ts";
import type { BlumePageRoute } from "./integration.ts";

const WORKSPACE_MARKERS = [
  ".git",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
];

/** True when the package.json at this path declares a `workspaces` field. */
const hasWorkspacesField = (pkgPath: string): boolean => {
  if (!existsSync(pkgPath)) {
    return false;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      workspaces?: unknown;
    };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
};

/** True when a directory looks like a workspace/monorepo root. */
const hasWorkspaceMarker = (dir: string): boolean =>
  hasWorkspacesField(join(dir, "package.json")) ||
  WORKSPACE_MARKERS.some((marker) => existsSync(join(dir, marker)));

/**
 * Walk up from the project root to the workspace/monorepo root so Vite's
 * `fs.allow` can reach hoisted dependencies — e.g. KaTeX fonts that resolve to
 * a monorepo root `node_modules` outside the project directory. Falls back to
 * the project root when no workspace markers are found.
 */
const findWorkspaceRoot = (start: string): string => {
  let dir = start;
  for (;;) {
    if (hasWorkspaceMarker(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
};

const ADAPTER_IMPORTS: Record<string, string> = {
  cloudflare: "@astrojs/cloudflare",
  netlify: "@astrojs/netlify",
  node: "@astrojs/node",
  vercel: "@astrojs/vercel",
};

const ADAPTER_OPTIONS: Record<string, string> = {
  node: '{ mode: "standalone" }',
};

const mintlifyFsImport = (enabled: boolean): string =>
  enabled ? 'import { existsSync } from "node:fs";\n' : "";

const markdownImportNames = (isMintlifyProject: boolean): string =>
  [
    "blumeMarkdownProcessor",
    "blumeMdxProcessor",
    "codeTitleTransformer",
    ...(isMintlifyProject
      ? [
          "rewriteMintlifyGlobalVariables",
          "rewriteMintlifyAsyncApiPage",
          "rewriteMintlifyManualApiPage",
          "rewriteMintlifyMarkdownSnippets",
          "rewriteMintlifyOpenApiSchemaPage",
          "rewriteMintlifySvgIconProps",
        ]
      : []),
    ...(isMintlifyProject ? ["rewriteMintlifyUserVariable"] : []),
  ].join(", ");

const fsAllowConfig = (options: { mathEnabled: boolean; root: string }) => {
  // The project root plus the workspace root, so hoisted dependencies (e.g.
  // KaTeX fonts under a monorepo's root node_modules) stay servable in dev.
  const basePaths = [
    ...new Set([findWorkspaceRoot(options.root), options.root]),
  ].map((path) => JSON.stringify(path));
  if (!options.mathEnabled) {
    return {
      imports: "",
      paths: basePaths,
      setup: "",
    };
  }
  return {
    imports:
      'import { createRequire } from "node:module";\nimport { dirname } from "node:path";\n',
    paths: [...basePaths, 'dirname(require.resolve("katex/package.json"))'],
    setup: "const require = createRequire(import.meta.url);\n",
  };
};

const mintlifyRootImportPluginTemplate = (root: string): string => `{
        name: "blume-mintlify-root-imports",
        enforce: "pre",
        resolveId(source) {
          const projectRoot = ${JSON.stringify(root)};
          const candidate = projectRoot + source;
          if (
            /^\\/(?!@fs\\/|@vite\\/|node_modules\\/).+\\.(?:md|mdx|js|jsx|ts|tsx)$/u.test(source) &&
            !source.startsWith(projectRoot + "/") &&
            existsSync(candidate)
          ) {
            return candidate;
          }
        },
      }`;

const mintlifyMdxSnippetPluginTemplate = (
  root: string,
  api: ResolvedConfig["api"],
  variables: Record<string, string>
): string => `{
        name: "blume-mintlify-mdx-snippets",
        enforce: "pre",
        async transform(code, id) {
          const contentPath = id.split("?")[0];
          if (/\\.mdx?$/u.test(contentPath)) {
            const withSnippets = await rewriteMintlifyMarkdownSnippets(code, { filePath: contentPath, root: ${JSON.stringify(root)} });
            const withSvgIcons = rewriteMintlifySvgIconProps(withSnippets);
            const withSchema = await rewriteMintlifyOpenApiSchemaPage(withSvgIcons, { filePath: contentPath, generation: ${JSON.stringify({ examples: api.examples, params: api.params })}, root: ${JSON.stringify(root)}, specs: ${JSON.stringify(api.openapi)} });
            const withManualApi = rewriteMintlifyManualApiPage(withSchema, { api: ${JSON.stringify(api)} });
            const withAsyncApi = await rewriteMintlifyAsyncApiPage(withManualApi, { root: ${JSON.stringify(root)}, specs: ${JSON.stringify(api.asyncapi)} });
            const withVariables = rewriteMintlifyGlobalVariables(withAsyncApi, ${JSON.stringify(variables)});
            return { code: rewriteMintlifyUserVariable(withVariables), map: null };
          }
        },
      }`;

const markdownAcceptPluginTemplate = (options: {
  base?: string;
  markdownDataPath: string;
}): string => `{
        name: "blume-markdown-accept",
        configureServer(server) {
          const markdownMediaTypes = new Set(["text/markdown", "text/plain"]);
          const acceptsMarkdown = (accept) =>
            accept
              ?.split(",")
              .some((item) => {
                const [type = "", ...params] = item
                  .trim()
                  .toLowerCase()
                  .split(";")
                  .map((part) => part.trim());
                if (!markdownMediaTypes.has(type)) {
                  return false;
                }
                const q = params.find((param) => param.startsWith("q="));
                if (!q) {
                  return true;
                }
                const value = Number.parseFloat(q.slice(2));
                return Number.isNaN(value) || value > 0;
              }) ?? false;
          const normalizedRoute = (url) => {
            const base = ${JSON.stringify(options.base?.replace(/\/$/u, "") ?? "")};
            const pathname = new URL(url ?? "/", "http://blume.local").pathname;
            const withoutBase =
              base && pathname.startsWith(\`\${base}/\`)
                ? pathname.slice(base.length)
                : pathname;
            const route = withoutBase.replace(/\\/$/u, "");
            return route || "/";
          };

          server.middlewares.use(async (request, response, next) => {
            if (!acceptsMarkdown(request.headers.accept)) {
              return next();
            }

            try {
              const { readFile } = await import("node:fs/promises");
              const markdownByRoute = JSON.parse(
                await readFile(${JSON.stringify(options.markdownDataPath)}, "utf-8")
              );
              const markdown = markdownByRoute[normalizedRoute(request.url)];
              if (!markdown) {
                return next();
              }
              response.statusCode = 200;
              response.setHeader("Content-Type", "text/markdown;charset=utf-8");
              response.setHeader("Vary", "Accept");
              response.end(markdown);
            } catch {
              next();
            }
          });
        },
      }`;

const vitePluginEntries = (options: {
  base?: string;
  isMintlifyProject: boolean;
  markdownDataPath?: string;
  api: ResolvedConfig["api"];
  root: string;
  variables: Record<string, string>;
}): string[] => {
  const plugins = ["tailwindcss()"];
  if (options.markdownDataPath) {
    plugins.push(
      markdownAcceptPluginTemplate({
        base: options.base,
        markdownDataPath: options.markdownDataPath,
      })
    );
  }
  if (options.isMintlifyProject) {
    plugins.push(
      mintlifyRootImportPluginTemplate(options.root),
      mintlifyMdxSnippetPluginTemplate(
        options.root,
        options.api,
        options.variables
      )
    );
  }
  return plugins;
};

/**
 * Integration packages the generated runtime imports. Declaring them in
 * `.blume/package.json` lets Astro's framework-package crawl discover and bundle
 * them — notably the React renderer's server entry, which imports the
 * `astro:react:opts` virtual module and must not be externalized (this applies
 * across the `ssr`, `prerender`, and `client` Vite environments).
 */
export const runtimeDependencies = (options: {
  config: ResolvedConfig;
  needsReact: boolean;
}): string[] => {
  const { config, needsReact } = options;
  const deps = ["@astrojs/mdx"];
  if (needsReact) {
    deps.push("@astrojs/react");
  }
  const { deployment } = config;
  if (deployment.output === "server" && deployment.adapter) {
    const adapter = ADAPTER_IMPORTS[deployment.adapter];
    if (adapter) {
      deps.push(adapter);
    }
  }
  return deps;
};

/** Generate `.blume/astro.config.mjs`. */
export const astroConfigTemplate = (options: {
  context: ProjectContext;
  config: ResolvedConfig;
  needsReact: boolean;
  pages: BlumePageRoute[];
  dataPath: string;
  markdownDataPath: string;
  themePath: string;
}): string => {
  const {
    config,
    context,
    dataPath,
    markdownDataPath,
    needsReact,
    pages,
    themePath,
  } = options;
  const { deployment } = config;
  const server = deployment.output === "server";
  const isMintlifyProject = context.configFile?.endsWith("docs.json") === true;

  const adapterImport =
    server && deployment.adapter
      ? `import adapter from "${ADAPTER_IMPORTS[deployment.adapter]}";\n`
      : "";
  const adapterArgs =
    server && deployment.adapter
      ? (ADAPTER_OPTIONS[deployment.adapter] ?? "")
      : "";
  const adapterOption =
    server && deployment.adapter ? `\n  adapter: adapter(${adapterArgs}),` : "";

  const siteOption = deployment.site
    ? `\n  site: ${JSON.stringify(deployment.site)},`
    : "";
  const baseOption = deployment.base
    ? `\n  base: ${JSON.stringify(deployment.base)},`
    : "";

  const redirectsOption =
    config.redirects.length > 0
      ? `\n  redirects: ${JSON.stringify(
          Object.fromEntries(
            config.redirects.map((redirect) => [
              redirect.from,
              { destination: redirect.to, status: redirect.status },
            ])
          )
        )},`
      : "";

  // React is only wired in when the project actually uses React islands. The
  // core theme is Astro-first and ships no client JS.
  const reactImport = needsReact ? `import react from "@astrojs/react";\n` : "";
  const fsImport = mintlifyFsImport(isMintlifyProject);
  const blumeImport = pages.length
    ? `import { blumeIntegration } from "blume/astro";\n`
    : "";
  const fsAllow = fsAllowConfig({
    mathEnabled: config.markdown.math,
    root: context.root,
  });

  const integrations = [
    `mdx({ processor: blumeMdxProcessor(${JSON.stringify({
      math: config.markdown.math,
    })}) })`,
  ];
  if (needsReact) {
    integrations.push("react()");
  }
  if (pages.length) {
    integrations.push(`blumeIntegration(${JSON.stringify({ pages })})`);
  }
  const vitePlugins = vitePluginEntries({
    api: config.api,
    base: config.deployment.base,
    isMintlifyProject,
    markdownDataPath: config.ai.llmsTxt ? markdownDataPath : undefined,
    root: context.root,
    variables: config.variables,
  });
  const markdownImports = markdownImportNames(isMintlifyProject);
  const codeBlockThemes = JSON.stringify(config.markdown.codeBlocks.theme);

  return `// Generated by Blume. Do not edit; this file is recreated on each run.
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { ${markdownImports} } from "blume/markdown";
${fsAllow.imports}${fsImport}${reactImport}${blumeImport}${adapterImport}
${fsAllow.setup}
export default defineConfig({
  root: ${JSON.stringify(context.outDir)},
  srcDir: ${JSON.stringify(`${context.outDir}/src`)},
  outDir: ${JSON.stringify(`${context.root}/dist`)},
  publicDir: ${JSON.stringify(context.publicRoot)},
  cacheDir: ${JSON.stringify(`${context.root}/node_modules/.cache/blume/astro`)},
  output: ${JSON.stringify(deployment.output)},${adapterOption}${siteOption}${baseOption}${redirectsOption}
  integrations: [${integrations.join(", ")}],
  markdown: {
    processor: blumeMarkdownProcessor(),
    shikiConfig: {
      themes: ${codeBlockThemes},
      defaultColor: false,
      transformers: [codeTitleTransformer()],
    },
  },
  devToolbar: { enabled: false },
  vite: {
    plugins: [${vitePlugins.join(", ")}],
    resolve: {
      alias: {
        "blume:data": ${JSON.stringify(dataPath)},
        "blume:theme": ${JSON.stringify(themePath)},
      },
    },
    server: {
      fs: {
        allow: [${fsAllow.paths.join(", ")}],
      },
    },
  },
});
`;
};

/** Generate `.blume/src/content.config.ts`. */
export const contentConfigTemplate = (options: {
  context: ProjectContext;
  config: ResolvedConfig;
}): string => {
  const { context, config } = options;
  return `// Generated by Blume. Do not edit.
import { defineCollection } from "astro:content";
import { blumeContentLoader } from "blume/astro";

const docs = defineCollection({
  loader: blumeContentLoader({
    additionalBases: ${JSON.stringify(context.generatedContentRoot ? [context.generatedContentRoot] : [])},
    base: ${JSON.stringify(context.contentRoot)},
    ignore: ${JSON.stringify(config.content.exclude)},
    pattern: ${JSON.stringify(config.content.include)},
  }),
});

export const collections = { docs };
`;
};

/** Generate `.blume/src/pages/[...slug].astro`, the docs catch-all route. */
/** Generate the Ask AI server endpoint (`.blume/src/pages/api/ask.ts`). */
export const askEndpointTemplate = (model: string): string =>
  `// Generated by Blume. Do not edit.
import type { APIRoute } from "astro";
import { streamText } from "ai";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const { messages } = await request.json();
  const result = streamText({
    model: ${JSON.stringify(model)},
    system:
      "You are a helpful documentation assistant. Answer using the project's documentation.",
    messages,
  });
  return result.toTextStreamResponse();
};
`;

/** Generate the Orama search index endpoint (`/blume-search.json`). */
export const searchEndpointTemplate = (): string =>
  `// Generated by Blume. Do not edit.
import documents from "../generated/search.json";

export const prerender = true;

export function GET() {
  return new Response(JSON.stringify(documents), {
    headers: { "Content-Type": "application/json" },
  });
}
`;

/**
 * Generate the raw-Markdown endpoints (`[...slug].md.ts` and `[...slug].mdx.ts`).
 * Each route's source is served so `/<route>.md` returns plain Markdown.
 */
export const rawMarkdownEndpointTemplate = (): string =>
  `// Generated by Blume. Do not edit.
import raw from "../generated/raw-markdown.json";

export const prerender = true;

export function getStaticPaths() {
  return Object.keys(raw).map((route) => ({
    params: { slug: route === "/" ? "index" : route.slice(1) },
    props: { route },
  }));
}

export function GET({ props }) {
  return new Response(raw[props.route] ?? "", {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
`;

/**
 * Generate the RSS endpoint (`[section]/rss.xml.ts`). One feed per content
 * type is served from the generated `rss.json`, e.g. `/blog/rss.xml`.
 */
export const rssEndpointTemplate = (): string =>
  `// Generated by Blume. Do not edit.
import feeds from "../../generated/rss.json";

export const prerender = true;

export function getStaticPaths() {
  return Object.keys(feeds).map((section) => ({
    params: { section },
    props: { section },
  }));
}

export function GET({ props }) {
  return new Response(feeds[props.section] ?? "", {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
`;

/** Generate the OG image endpoint (`.blume/src/pages/_og/[...slug].png.ts`). */
export const ogEndpointTemplate = (): string =>
  `// Generated by Blume. Do not edit.
import { renderOgImage } from "blume/og";
import data from "../../generated/data.json";

export const prerender = true;

export function getStaticPaths() {
  return data.routes.map((route) => ({
    params: { slug: route.path === "/" ? "index" : route.path.slice(1) },
    props: { title: route.title },
  }));
}

export async function GET({ props }) {
  const png = await renderOgImage({
    title: props.title,
    eyebrow: data.config.title,
    accent: data.config.theme.accent,
  });
  return new Response(png, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/png",
    },
  });
}
`;

export const catchAllPageTemplate = (options: {
  askEnabled: boolean;
  mathEnabled: boolean;
}): string => {
  const askImport = options.askEnabled
    ? 'import AskAI from "blume/components/islands/AskAI.astro";\n'
    : "";
  const askSlot = options.askEnabled ? '\n  <AskAI slot="ask" />' : "";
  const mathImport = options.mathEnabled
    ? 'import Math from "blume/components/content/Math.astro";\n'
    : "";
  const mathEntry = options.mathEnabled ? "Math,\n  " : "";

  return `---
// Generated by Blume. Do not edit.
import { getEntry, render } from "astro:content";
import RootLayout from "blume/components/layout/RootLayout.astro";
${askImport}
import Accordion from "blume/components/content/Accordion.astro";
import AccordionItem from "blume/components/content/AccordionItem.astro";
import Badge from "blume/components/content/Badge.astro";
import Callout from "blume/components/content/Callout.astro";
import Card from "blume/components/content/Card.astro";
import CardGroup from "blume/components/content/CardGroup.astro";
import CodeGroup from "blume/components/content/CodeGroup.astro";
import ColorRoot from "blume/components/content/Color.astro";
import ColorItem from "blume/components/content/ColorItem.astro";
import ColorRow from "blume/components/content/ColorRow.astro";
import Column from "blume/components/content/Column.astro";
import Columns from "blume/components/content/Columns.astro";
import Expandable from "blume/components/content/Expandable.astro";
import FileTree from "blume/components/content/FileTree.astro";
import Frame from "blume/components/content/Frame.astro";
import Panel from "blume/components/content/Panel.astro";
import ParamField from "blume/components/content/ParamField.astro";
import Prompt from "blume/components/content/Prompt.astro";
import ResponseField from "blume/components/content/ResponseField.astro";
import Step from "blume/components/content/Step.astro";
import Steps from "blume/components/content/Steps.astro";
import Tab from "blume/components/content/Tab.astro";
import Tabs from "blume/components/content/Tabs.astro";
import Tile from "blume/components/content/Tile.astro";
import Tooltip from "blume/components/content/Tooltip.astro";
import TreeRoot from "blume/components/content/Tree.astro";
import TreeFile from "blume/components/content/TreeFile.astro";
import TreeFolder from "blume/components/content/TreeFolder.astro";
import Visibility from "blume/components/content/Visibility.astro";
import Warning from "blume/components/content/Warning.astro";
import AuthMethod from "blume/components/api/AuthMethod.astro";
import Endpoint from "blume/components/api/Endpoint.astro";
import ParameterTable from "blume/components/api/ParameterTable.astro";
import RequestExample from "blume/components/api/RequestExample.astro";
import ResponseExample from "blume/components/api/ResponseExample.astro";
import Icon from "blume/components/Icon.astro";
${mathImport}import { mdxComponents as userMdx } from "../generated/components.ts";
import data from "../generated/data.json";

const Color = Object.assign(ColorRoot, { Item: ColorItem, Row: ColorRow });
const Tree = Object.assign(TreeRoot, { File: TreeFile, Folder: TreeFolder });

// Docs content is file-based and always prerendered, even in server output
// (where only endpoints like /api/ask render on demand). Without this, server
// builds would render this route on demand and ignore getStaticPaths, leaving
// the entry id undefined.
export const prerender = true;

const components = {
  Accordion,
  AccordionItem,
  AuthMethod,
  Badge,
  Callout,
  Card,
  CardGroup,
  CodeGroup,
  Color,
  Column,
  Columns,
  Endpoint,
  Expandable,
  FileTree,
  Frame,
  Icon,
  Panel,
  ParameterTable,
  ParamField,
  Prompt,
  RequestExample,
  ResponseExample,
  ResponseField,
  Step,
  Steps,
  Tab,
  Tabs,
  Tile,
  Tooltip,
  Tree,
  Visibility,
  ${mathEntry}...userMdx,
};

export function getStaticPaths() {
  return data.routes.map((route) => ({
    params: { slug: route.path === "/" ? undefined : route.path.slice(1) },
    props: {
      editUrl: route.editUrl,
      entryId: route.id,
      indexable: route.indexable,
      route: route.path,
      title: route.title,
    },
  }));
}

const { entryId, route, title, indexable, editUrl } = Astro.props;
const entry = await getEntry("docs", entryId);
if (!entry) {
  return new Response(null, { status: 404 });
}
const { Content, headings } = await render(entry);
const frontmatter = entry.data ?? {};

const seo = frontmatter.seo ?? {};
const base = data.config.site ? data.config.site.replace(/\\/$/, "") : null;

const ogPath = data.config.og.enabled
  ? \`/og/\${route === "/" ? "index" : route.slice(1)}.png\`
  : null;
const ogRel = seo.image ?? ogPath;
const ogImage = ogRel && base ? \`\${base}\${ogRel}\` : ogRel;

const canonical =
  seo.canonical ?? (base ? \`\${base}\${route === "/" ? "" : route}\` : null);
---

<RootLayout
  site={{ title: data.config.title, description: data.config.description }}
  logo={data.config.logo}
  banner={data.config.banner}
  imageZoom={data.config.imageZoom}
  navigation={data.navigation}
  page={{ title: seo.title ?? title, description: seo.description ?? frontmatter.description, route }}
  headings={headings}
  themeMode={data.config.theme.mode}
  searchEnabled={data.config.search.enabled}
  searchProvider={data.config.search.provider}
  indexable={indexable}
  ogImage={ogImage}
  canonical={canonical}
  editUrl={editUrl}
  repoUrl={data.config.repoUrl}
  askEnabled={${options.askEnabled}}
  feeds={data.feeds}
  siteUrl={data.config.site}
  pageType={frontmatter.type}
  published={frontmatter.date ?? frontmatter.changelog?.date ?? null}
  noindex={seo.noindex}
  structuredDataEnabled={data.config.structuredData}
>${askSlot}
  <Content components={components} />
</RootLayout>
`;
};

/**
 * Generate `.blume/src/pages/changelog.astro` — the changelog index. Collects
 * every `type: changelog` entry, sorts newest-first, and renders each through
 * the `Update` timeline layout (date/version rail + entry content). Only written
 * by {@link generateAstroProject} when changelog entries exist.
 */
export const changelogIndexTemplate = (options: {
  askEnabled: boolean;
}): string => {
  const askImport = options.askEnabled
    ? 'import AskAI from "blume/components/islands/AskAI.astro";\n'
    : "";
  const askSlot = options.askEnabled ? '\n  <AskAI slot="ask" />' : "";

  return `---
// Generated by Blume. Do not edit.
import { getCollection, render } from "astro:content";
import RootLayout from "blume/components/layout/RootLayout.astro";
import Update from "blume/components/content/Update.astro";
${askImport}import data from "../generated/data.json";

export const prerender = true;

const entryDate = (entry) =>
  entry.data.date ?? entry.data.changelog?.date ?? null;

const toTime = (value) => {
  if (!value) {
    return 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

const formatDate = (value) => {
  if (!value) {
    return;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat("en", {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(date);
};

const slugify = (text) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
  "update";

const changelogEntries = (await getCollection("docs"))
  .filter(
    (entry) =>
      entry.data.type === "changelog" &&
      !entry.data.draft &&
      !entry.data.sidebar?.hidden
  )
  .toSorted((a, b) => toTime(entryDate(b)) - toTime(entryDate(a)));

const items = await Promise.all(
  changelogEntries.map(async (entry) => {
    const label =
      entry.data.title ??
      (entry.data.changelog?.version
        ? "v" + entry.data.changelog.version
        : "Update");
    return {
      Content: (await render(entry)).Content,
      date: formatDate(entryDate(entry)),
      id: slugify(label),
      label,
      tags: entry.data.changelog?.category
        ? [entry.data.changelog.category]
        : [],
    };
  })
);

const headings = items.map((item) => ({
  depth: 2,
  slug: item.id,
  text: item.label,
}));

const base = data.config.site ? data.config.site.replace(/\\/$/, "") : null;
const canonical = base ? base + "/changelog" : null;
---

<RootLayout
  site={{ title: data.config.title, description: data.config.description }}
  logo={data.config.logo}
  banner={data.config.banner}
  imageZoom={data.config.imageZoom}
  navigation={data.navigation}
  page={{
    title: data.config.title + " changelog",
    description: "Product updates and release notes.",
    route: "/changelog",
  }}
  headings={headings}
  themeMode={data.config.theme.mode}
  searchEnabled={data.config.search.enabled}
  searchProvider={data.config.search.provider}
  indexable={true}
  ogImage={null}
  canonical={canonical}
  repoUrl={data.config.repoUrl}
  askEnabled={${options.askEnabled}}
  feeds={data.feeds}
  siteUrl={data.config.site}
  noindex={false}
  structuredDataEnabled={data.config.structuredData}
>${askSlot}
  <h1>Changelog</h1>
  {
    items.length === 0 ? (
      <p>No changelog entries yet.</p>
    ) : (
      <div class="not-prose mt-8">
        {items.map(({ Content, id, label, date, tags }) => (
          <Update description={date} id={id} label={label} tags={tags}>
            <Content />
          </Update>
        ))}
      </div>
    )
  }
</RootLayout>
`;
};

/**
 * Generate `.blume/src/generated/components.ts`, which re-exports the user's
 * component overrides (or empty maps when no `components.ts` exists). Importing
 * the user file here lets Astro/Vite compile any `.astro`/`.tsx` it references.
 */
export const userComponentsTemplate = (
  componentsFile: string | null
): string => {
  if (!componentsFile) {
    return `// Generated by Blume. Do not edit.
export const mdxComponents = {};
export const layoutOverrides = {};
`;
  }
  return `// Generated by Blume. Do not edit.
import overrides from ${JSON.stringify(componentsFile)};
export const mdxComponents = overrides.mdx ?? {};
export const layoutOverrides = overrides.layout ?? {};
`;
};

/** Generate `.blume/src/env.d.ts`. */
export const envTemplate =
  (): string => `/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
`;

/** Generate `.blume/package.json`. */
export const runtimePackageTemplate = (dependencies: string[] = []): string =>
  `${JSON.stringify(
    {
      dependencies: Object.fromEntries(
        [...dependencies].toSorted().map((name) => [name, "*"])
      ),
      name: "blume-runtime",
      private: true,
      type: "module",
      version: "0.0.0",
    },
    null,
    2
  )}\n`;

/** Generate `.blume/tsconfig.json`. */
export const runtimeTsconfigTemplate = (): string =>
  `${JSON.stringify(
    {
      exclude: ["dist"],
      extends: "astro/tsconfigs/strict",
      include: [".astro/types.d.ts", "**/*"],
    },
    null,
    2
  )}\n`;
