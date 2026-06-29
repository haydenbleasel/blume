import { existsSync, readFileSync } from "node:fs";

import { dirname, join } from "pathe";

import { askBackendRuntimeDep } from "../ai/ask.ts";
import type { AskBackend } from "../ai/ask.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import type { ProjectContext } from "../core/types.ts";
import { searchProviderMeta } from "../search/providers.ts";
import { buildFontEntries } from "../theme/fonts.ts";
import type { BlumePageRoute } from "./integration.ts";
import type { IslandSpec } from "./islands.ts";

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
  needsVue?: boolean;
  needsSvelte?: boolean;
}): string[] => {
  const { config, needsReact, needsSvelte, needsVue } = options;
  const deps = ["@astrojs/mdx"];
  if (needsReact) {
    deps.push("@astrojs/react");
  }
  if (needsVue) {
    deps.push("@astrojs/vue");
  }
  if (needsSvelte) {
    deps.push("@astrojs/svelte");
  }
  // The Scalar integration is only declared when an API reference is configured,
  // so projects that don't use it never pull it into the runtime.
  if (config.openapi.enabled || config.asyncapi.enabled) {
    deps.push("@scalar/astro");
  }
  // Only the configured search provider's SDK is declared, so a project pulls in
  // (and the user installs) exactly the backend it uses — nothing more.
  deps.push(...searchProviderMeta(config.search.provider).runtimeDeps);
  // Ask AI's provider SDK, when its backend needs one (gateway uses core `ai`).
  if (config.ai.ask?.enabled) {
    const askDep = askBackendRuntimeDep(config.ai.ask);
    if (askDep) {
      deps.push(askDep);
    }
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
  needsVue?: boolean;
  needsSvelte?: boolean;
  pages: BlumePageRoute[];
  contentRoutes: string[];
  dataPath: string;
  themePath: string;
  searchClientPath: string;
}): string => {
  const { context, config, needsReact, pages, dataPath, themePath } = options;
  const { contentRoutes, needsSvelte, needsVue, searchClientPath } = options;
  const { deployment } = config;
  const server = deployment.output === "server";

  // The project root plus the workspace root, so hoisted dependencies (e.g.
  // KaTeX fonts under a monorepo's root node_modules) stay servable in dev.
  const fsAllow = [...new Set([findWorkspaceRoot(context.root), context.root])];

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

  // Astro's native i18n gives locale-aware helpers + `<html lang>` correctness.
  // Blume owns getStaticPaths and materializes fallback routes in the manifest,
  // so we deliberately omit Astro's `fallback` to keep one source of routing.
  const i18nOption = config.i18n
    ? `\n  i18n: ${JSON.stringify({
        defaultLocale: config.i18n.defaultLocale,
        locales: config.i18n.locales.map((locale) => locale.code),
        routing: {
          prefixDefaultLocale: !config.i18n.hideDefaultLocalePrefix,
        },
      })},`
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

  // Self-hosted Google Fonts via Astro's Fonts API, derived from theme.fonts.
  // `fontProviders` is only imported when at least one font is configured.
  const fontEntries = buildFontEntries(config.theme.fonts);
  const fontsOption = fontEntries.length
    ? `\n  fonts: [${fontEntries
        .map(
          (font) =>
            `{ provider: fontProviders.google(), name: ${JSON.stringify(
              font.name
            )}, cssVariable: ${JSON.stringify(
              font.cssVariable
            )}, weights: ${JSON.stringify(
              font.weights
            )}, fallbacks: ${JSON.stringify(font.fallbacks)} }`
        )
        .join(", ")}],`
    : "";
  const defineConfigImport = fontEntries.length
    ? `import { defineConfig, fontProviders } from "astro/config";`
    : `import { defineConfig } from "astro/config";`;

  // Framework renderers are only wired in when an island (or Ask AI, for React)
  // needs them. The core theme is Astro-first and ships no client JS.
  const reactImport = needsReact ? `import react from "@astrojs/react";\n` : "";
  const vueImport = needsVue ? `import vue from "@astrojs/vue";\n` : "";
  const svelteImport = needsSvelte
    ? `import svelte from "@astrojs/svelte";\n`
    : "";
  const blumeImport = `import { blumeIntegration } from "blume/astro";\n`;

  // Twoslash runs first, before the always-on transformers, but only on fences
  // with the `twoslash` meta (explicitTrigger) — so it's opt-in per block with
  // no config flag; the TypeScript compiler only spins up when a block uses it.
  const twoslashImport = `import { transformerTwoslash } from "@shikijs/twoslash";\n`;
  const twoslashTransformer =
    "transformerTwoslash({ explicitTrigger: true }), ";

  const integrations = [
    `mdx({ processor: blumeMdxProcessor(${JSON.stringify({
      headingAnchors: config.markdown.headingAnchors,
      inline: config.markdown.code.inline,
      math: config.markdown.math,
    })}) })`,
  ];
  if (needsReact) {
    integrations.push("react()");
  }
  if (needsVue) {
    integrations.push("vue()");
  }
  if (needsSvelte) {
    integrations.push("svelte()");
  }
  // Always mounted: injects user pages (a no-op when there are none) and wires
  // up dev-server `Accept: text/markdown` negotiation over the content routes.
  integrations.push(
    `blumeIntegration(${JSON.stringify({ contentRoutes, pages })})`
  );

  return `// Generated by Blume. Do not edit; this file is recreated on each run.
${defineConfigImport}
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { blumeMarkdownProcessor, blumeMdxProcessor, blumeShikiTransformers } from "blume/markdown";
${twoslashImport}${reactImport}${vueImport}${svelteImport}${blumeImport}${adapterImport}
export default defineConfig({
  root: ${JSON.stringify(context.outDir)},
  srcDir: ${JSON.stringify(`${context.outDir}/src`)},
  outDir: ${JSON.stringify(`${context.root}/dist`)},
  publicDir: ${JSON.stringify(`${context.root}/public`)},
  output: ${JSON.stringify(deployment.output)},${adapterOption}${siteOption}${baseOption}${redirectsOption}${i18nOption}${fontsOption}
  integrations: [${integrations.join(", ")}],
  markdown: {
    processor: blumeMarkdownProcessor(${JSON.stringify({
      headingAnchors: config.markdown.headingAnchors,
      inline: config.markdown.code.inline,
    })}),
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      defaultColor: false,
      transformers: [${twoslashTransformer}...blumeShikiTransformers(${JSON.stringify(
        { icons: config.markdown.code.icons }
      )})],
    },
  },
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    // @takumi-rs/core (OG image rendering) is a native NAPI addon that loads a
    // platform-specific .node binding via createRequire(import.meta.url). Astro's
    // build bundles it into the per-environment output by default, which
    // relocates import.meta.url and breaks the binding lookup ("Cannot find
    // native binding") on other platforms (e.g. the Linux CI runner). Astro 7
    // configures externalization per Vite environment, so it must be forced
    // external on the prerender (static) and ssr (server) environments -- a
    // top-level ssr.external only reaches the latter -- so the binding resolves
    // from node_modules at runtime instead.
    environments: {
      prerender: { resolve: { external: ["@takumi-rs/core"] } },
      ssr: { resolve: { external: ["@takumi-rs/core"] } },
    },
    resolve: {
      alias: {
        "blume:data": ${JSON.stringify(dataPath)},
        "blume:search-client": ${JSON.stringify(searchClientPath)},
        "blume:theme": ${JSON.stringify(themePath)},
      },
    },
    server: {
      fs: {
        allow: ${JSON.stringify(fsAllow)},
      },
    },
  },
});
`;
};

/** The default staged-content base, relative to the runtime `outDir`. */
export const stagedContentDir = (outDir: string): string =>
  join(outDir, "content");

/** Generate `.blume/src/content.config.ts`. */
export const contentConfigTemplate = (options: {
  context: ProjectContext;
  config: ResolvedConfig;
  /** Whether any non-filesystem source materialized MDX into the staged dir. */
  staged?: boolean;
  /** Base dir for the staged collection; defaults to `<outDir>/content`. */
  stagedBase?: string;
}): string => {
  const { context, config } = options;
  const stagedBase = options.stagedBase ?? stagedContentDir(context.outDir);

  // Non-filesystem sources render through a parallel `staged` collection backed
  // by materialized MDX, so the filesystem `docs` collection stays untouched.
  const stagedBlock = options.staged
    ? `
const staged = defineCollection({
  loader: glob({
    pattern: ["**/*.{md,mdx}"],
    base: ${JSON.stringify(stagedBase)},
    generateId: ({ entry }) => entry,
  }),
});
`
    : "";

  return `// Generated by Blume. Do not edit.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({
    pattern: ${JSON.stringify(config.content.include)},
    base: ${JSON.stringify(context.contentRoot)},
    generateId: ({ entry }) => entry,
  }),
});
${stagedBlock}
export const collections = { docs${options.staged ? ", staged" : ""} };
`;
};

/** Generate `.blume/src/pages/[...slug].astro`, the docs catch-all route. */
/** Generate the Ask AI server endpoint (`.blume/src/pages/api/ask.ts`). */
export const askEndpointTemplate = (backend: AskBackend): string => {
  const imports = [
    'import type { APIRoute } from "astro";',
    'import { streamText } from "ai";',
  ];
  let setup = "";
  let modelExpr = JSON.stringify(backend.model);
  if (backend.kind === "openrouter") {
    imports.push(
      'import { createOpenRouter } from "@openrouter/ai-sdk-provider";'
    );
    setup = `\nconst openrouter = createOpenRouter({ apiKey: process.env[${JSON.stringify(
      backend.apiKeyEnv
    )}] });\n`;
    modelExpr = `openrouter(${JSON.stringify(backend.model)})`;
  } else if (backend.kind === "openai-compatible") {
    imports.push(
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";'
    );
    setup = `\nconst provider = createOpenAICompatible({
  apiKey: process.env[${JSON.stringify(backend.apiKeyEnv)}],
  baseURL: ${JSON.stringify(backend.baseUrl)},
  name: ${JSON.stringify(backend.name)},
});\n`;
    modelExpr = `provider(${JSON.stringify(backend.model)})`;
  }
  return `// Generated by Blume. Do not edit.
${imports.join("\n")}

export const prerender = false;
${setup}
export const POST: APIRoute = async ({ request }) => {
  const { messages } = await request.json();
  const result = streamText({
    model: ${modelExpr},
    system:
      "You are a helpful documentation assistant. Answer using the project's documentation.",
    messages,
  });
  return result.toTextStreamResponse();
};
`;
};

/** Generate the static search index endpoint (`/blume-search.json`). */
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

const SEARCH_CLIENT_HEADER = "// Generated by Blume. Do not edit.\n";

/** Import the chosen provider's `createSearch` from the Blume package. */
const searchClientImport = (module: string): string =>
  `import { createSearch as create } from "blume/components/layout/search/${module}.ts";\n`;

/** A client that loads a static `blume-search.json` index (Orama, FlexSearch). */
const staticSearchClient = (module: string): string =>
  `${SEARCH_CLIENT_HEADER}${searchClientImport(module)}
const indexUrl = \`\${import.meta.env.BASE_URL}blume-search.json\`.replace("//", "/");

export const createSearch = () => create({ indexUrl });
`;

/** A client that passes public credentials straight to the provider SDK. */
const hostedSearchClient = (
  module: string,
  options: Record<string, unknown>
): string =>
  `${SEARCH_CLIENT_HEADER}${searchClientImport(module)}
export const createSearch = () => create(${JSON.stringify(options)});
`;

/** Build the per-provider config object the hosted client is created with. */
const hostedSearchOptions = (
  search: ResolvedConfig["search"]
): { module: string; options: Record<string, unknown> } | null => {
  switch (search.provider) {
    case "algolia": {
      return { module: "algolia", options: { ...search.algolia } };
    }
    case "orama-cloud": {
      return {
        module: "orama-cloud",
        options: {
          apiKey: search.oramaCloud?.apiKey,
          endpoint: search.oramaCloud?.endpoint,
        },
      };
    }
    case "typesense": {
      return { module: "typesense", options: { ...search.typesense } };
    }
    default: {
      return null;
    }
  }
};

/**
 * Generate `.blume/src/generated/search-client.ts` — the provider-specific
 * loader the `<Search>` component lazy-imports via the `blume:search-client`
 * alias. Only the configured provider's module (and therefore its SDK) is
 * referenced, so the build bundles exactly one backend. Public credentials are
 * baked in here; secret keys never reach the client.
 */
export const searchClientTemplate = (config: ResolvedConfig): string => {
  const { search } = config;

  if (search.provider === "orama" || search.provider === "flexsearch") {
    return staticSearchClient(search.provider);
  }

  const hosted = hostedSearchOptions(search);
  if (hosted) {
    return hostedSearchClient(hosted.module, hosted.options);
  }

  if (search.provider === "mixedbread") {
    return `${SEARCH_CLIENT_HEADER}${searchClientImport("endpoint")}
const api = \`\${import.meta.env.BASE_URL}api/search\`.replace("//", "/");

export const createSearch = () => create({ api });
`;
  }

  if (search.provider === "pagefind") {
    return `${SEARCH_CLIENT_HEADER}${searchClientImport("pagefind")}
const url = \`\${import.meta.env.BASE_URL}pagefind/pagefind.js\`.replace("//", "/");

export const createSearch = () => create({ url });
`;
  }

  // Search disabled: a no-op client so the alias always resolves.
  return `${SEARCH_CLIENT_HEADER}export const createSearch = () => () =>
  Promise.resolve({ hits: [], sections: [] });
`;
};

/**
 * Generate the Mixedbread search endpoint (`/api/search`). It holds the secret
 * key server-side and proxies semantic queries to the configured store. The
 * result mapping is best-effort and may need tuning to how your content was
 * synced (see the Mixedbread sync step / \`mxbai vs sync\`).
 */
export const mixedbreadSearchEndpointTemplate = (storeId: string): string =>
  `// Generated by Blume. Do not edit.
import type { APIRoute } from "astro";
import Mixedbread from "@mixedbread/sdk";

export const prerender = false;

const client = new Mixedbread({ apiKey: process.env.MIXEDBREAD_API_KEY ?? "" });
const STORE_ID = ${JSON.stringify(storeId)};

export const POST: APIRoute = async ({ request }) => {
  const { query } = await request.json();
  if (!query) {
    return new Response("[]", {
      headers: { "Content-Type": "application/json" },
    });
  }
  const response = await client.stores.search({
    query,
    store_identifiers: [STORE_ID],
    top_k: 8,
  });
  const hits = (response.data ?? []).map((chunk) => {
    const meta = chunk.generated_metadata ?? {};
    return {
      excerpt: chunk.text ?? meta.excerpt ?? "",
      title: meta.title ?? chunk.filename ?? "",
      url: meta.url ?? "",
    };
  });
  return new Response(JSON.stringify(hits), {
    headers: { "Content-Type": "application/json" },
  });
};
`;

/**
 * Generate the raw-Markdown endpoints (`[...slug].md.ts` and `[...slug].mdx.ts`).
 * Each route's source is served verbatim so `/<route>.md` returns plain Markdown.
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

/** The `src/pages` file that serves a route, e.g. `/mcp` -> `mcp.ts`. */
export const mcpPageFile = (route: string): string => {
  const clean = route.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return `${clean}.ts`;
};

/**
 * Generate the hosted MCP server endpoint (e.g. `.blume/src/pages/mcp.ts`). A
 * thin wrapper around the shipped `createMcpFetchHandler`, served from the
 * generated data snapshot. Runs server-side (no prerender) so agents can query
 * the docs over Streamable HTTP.
 */
export const mcpEndpointTemplate = (route: string): string => {
  const clean = route.replace(/^\/+/u, "").replace(/\/+$/u, "");
  const up = "../".repeat(clean.split("/").length);
  return `// Generated by Blume. Do not edit.
import type { APIRoute } from "astro";
import { createMcpFetchHandler } from "blume/ai/mcp/server.ts";
import data from "${up}generated/mcp-data.json";

export const prerender = false;

const handler = createMcpFetchHandler(data);

export const ALL: APIRoute = ({ request }) => handler(request);
`;
};

/** Generate a prerendered endpoint that serves a fixed JSON payload. */
export const staticJsonEndpointTemplate = (payload: unknown): string =>
  `// Generated by Blume. Do not edit.
export const prerender = true;

const payload = ${JSON.stringify(payload, null, 2)};

export function GET() {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
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

/**
 * Generate a Scalar API/AsyncAPI reference page (`.blume/src/pages/<route>.astro`).
 * The reference UI is owned by Scalar (its standalone bundle, loaded from a CDN)
 * but mounted inside Blume's {@link ReferenceLayout} so the page keeps Blume's
 * navbar on top. `renderMode: "client"` mounts the reference into a container
 * element (rather than emitting a full HTML document), which is what lets it
 * live inside our shell. `dataImport` is the route-depth-aware relative path to
 * the generated data module the layout reads.
 */
export const scalarReferenceTemplate = (options: {
  configuration: Record<string, unknown>;
  dataImport: string;
  route: string;
  title: string;
}): string =>
  `---
// Generated by Blume. Do not edit.
import { ScalarComponent } from "@scalar/astro";
import ReferenceLayout from "blume/components/layout/ReferenceLayout.astro";
import data from ${JSON.stringify(options.dataImport)};

export const prerender = true;

const configuration = ${JSON.stringify(options.configuration, null, 2)};
---

<ReferenceLayout
  banner={data.config.banner}
  fontCssVars={data.fontCssVars}
  logo={data.config.logo}
  favicon={data.config.favicon}
  navigation={data.navigation}
  pageTitle={${JSON.stringify(options.title)}}
  route={${JSON.stringify(options.route)}}
  searchEnabled={data.config.search.enabled}
  site={{ title: data.config.title, description: data.config.description }}
  themeMode={data.config.theme.mode}
>
  <ScalarComponent configuration={configuration} renderMode="client" />
</ReferenceLayout>
`;

export const catchAllPageTemplate = (options: {
  askEnabled: boolean;
  exportEpub: boolean;
  exportPdf: boolean;
  mathEnabled: boolean;
}): string => {
  const askImport = options.askEnabled
    ? 'import AskAI from "blume/components/islands/AskAI.astro";\n'
    : "";
  const askSlot = options.askEnabled
    ? '\n  <AskAI slot="ask" strings={ui.ask} />'
    : "";
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
import AutoTypeTable from "blume/components/content/AutoTypeTable.astro";
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
import GithubInfo from "blume/components/content/GithubInfo.astro";
import Panel from "blume/components/content/Panel.astro";
import Prompt from "blume/components/content/Prompt.astro";
import Step from "blume/components/content/Step.astro";
import Steps from "blume/components/content/Steps.astro";
import Tab from "blume/components/content/Tab.astro";
import Tabs from "blume/components/content/Tabs.astro";
import Tile from "blume/components/content/Tile.astro";
import Tooltip from "blume/components/content/Tooltip.astro";
import TreeRoot from "blume/components/content/Tree.astro";
import TreeFile from "blume/components/content/TreeFile.astro";
import TreeFolder from "blume/components/content/TreeFolder.astro";
import TypeTable from "blume/components/content/TypeTable.astro";
import Visibility from "blume/components/content/Visibility.astro";
import Icon from "blume/components/Icon.astro";
${mathImport}import { mdxComponents as userMdx, layoutOverrides } from "../generated/components.ts";
import { islandComponents } from "../generated/islands.ts";
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
  AutoTypeTable,
  Badge,
  Callout,
  Card,
  CardGroup,
  CodeGroup,
  Color,
  Column,
  Columns,
  Expandable,
  FileTree,
  Frame,
  GithubInfo,
  Icon,
  Panel,
  Prompt,
  Step,
  Steps,
  Tab,
  Tabs,
  Tile,
  Tooltip,
  Tree,
  TypeTable,
  Visibility,
  ${mathEntry}...islandComponents,
  ...userMdx,
};

export function getStaticPaths() {
  return data.routes.map((route) => ({
    params: { slug: route.path === "/" ? undefined : route.path.slice(1) },
    props: {
      alternates: route.alternates,
      collection: route.collection,
      editUrl: route.editUrl,
      entryId: route.entryId,
      fallback: route.fallback,
      indexable: route.indexable,
      lastModified: route.lastModified,
      locale: route.locale,
      route: route.path,
      title: route.title,
    },
  }));
}

const { entryId, collection, route, title, indexable, editUrl, lastModified, locale, alternates, fallback } = Astro.props;
const entry = await getEntry(collection, entryId);
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

// Locale resolution. With i18n on, pick the active locale's nav + dictionary,
// build hreflang alternates, and derive the language-switcher targets.
const i18n = data.config.i18n;
const localePrefix = (codeArg) =>
  i18n && codeArg === i18n.defaultLocale && i18n.hideDefaultLocalePrefix
    ? ""
    : \`/\${codeArg}\`;
const localizeRoute = (logical, codeArg) => {
  const prefix = localePrefix(codeArg);
  if (!prefix) {
    return logical;
  }
  return logical === "/" ? prefix : \`\${prefix}\${logical}\`;
};
const stripLocale = (path, codeArg) => {
  const prefix = localePrefix(codeArg);
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
};

const navigation = i18n ? (data.navigationByLocale[locale] ?? data.navigation) : data.navigation;
const ui = i18n ? (data.uiByLocale[locale] ?? data.ui) : data.ui;
const localeMeta = i18n ? i18n.locales.find((l) => l.code === locale) : null;
const dir = localeMeta?.dir ?? "ltr";
const htmlLang = i18n ? locale : "en";
// A fallback page renders the fallback locale's content, so its text direction
// follows that language — not the (mirrored) page locale.
const contentLocale =
  fallback && i18n?.fallbackLocale ? i18n.fallbackLocale : locale;
const contentDir = i18n
  ? (i18n.locales.find((l) => l.code === contentLocale)?.dir ?? "ltr")
  : "ltr";
const absolute = (path) => base + (path === "/" ? "" : path);

const localeAlternates =
  i18n && base
    ? (alternates ?? []).map((alt) => ({ hreflang: alt.locale, href: absolute(alt.path) }))
    : [];
const defaultAlt = i18n ? (alternates ?? []).find((alt) => alt.locale === i18n.defaultLocale) : null;
const xDefault = defaultAlt && base ? absolute(defaultAlt.path) : null;

const logicalRoute = i18n ? stripLocale(route, locale) : route;
const localeSwitch = i18n
  ? i18n.locales.map((l) => {
      const alt = (alternates ?? []).find((x) => x.locale === l.code);
      return {
        code: l.code,
        current: l.code === locale,
        dir: l.dir,
        href: alt ? alt.path : localizeRoute(logicalRoute, l.code),
        label: l.label,
        untranslated: !alt,
      };
    })
  : [];
---

<RootLayout
  site={{ title: data.config.title, description: data.config.description }}
  layout={layoutOverrides}
  logo={data.config.logo}
  mcp={data.config.mcp}
  favicon={data.config.favicon}
  banner={data.config.banner}
  imageZoom={data.config.imageZoom}
  codeWrap={data.config.codeWrap}
  navigation={navigation}
  locale={htmlLang}
  dir={dir}
  contentDir={contentDir}
  ui={ui}
  localeAlternates={localeAlternates}
  xDefault={xDefault}
  localeSwitch={localeSwitch}
  page={{ title: seo.title ?? title, description: seo.description ?? frontmatter.description, route }}
  headings={headings}
  themeMode={data.config.theme.mode}
  fontCssVars={data.fontCssVars}
  searchEnabled={data.config.search.enabled}
  indexable={indexable}
  ogImage={ogImage}
  canonical={canonical}
  editUrl={editUrl}
  repoUrl={data.config.repoUrl}
  askEnabled={${options.askEnabled}}
  exportPdf={${options.exportPdf}}
  exportEpub={${options.exportEpub}}
  feeds={data.feeds}
  siteUrl={data.config.site}
  pageType={frontmatter.type}
  published={frontmatter.date ?? frontmatter.changelog?.date ?? null}
  lastModified={lastModified}
  noindex={seo.noindex}
  structuredDataEnabled={data.config.structuredData}
>${askSlot}
  <h1>{title}</h1>
  {frontmatter.description && <p class="mt-3 text-lg text-muted-foreground">{frontmatter.description}</p>}
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
  exportEpub: boolean;
  exportPdf: boolean;
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
import { layoutOverrides } from "../generated/components.ts";
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
  layout={layoutOverrides}
  logo={data.config.logo}
  mcp={data.config.mcp}
  favicon={data.config.favicon}
  banner={data.config.banner}
  imageZoom={data.config.imageZoom}
  codeWrap={data.config.codeWrap}
  navigation={data.navigation}
  page={{
    title: data.config.title + " changelog",
    description: "Product updates and release notes.",
    route: "/changelog",
  }}
  headings={headings}
  themeMode={data.config.theme.mode}
  fontCssVars={data.fontCssVars}
  searchEnabled={data.config.search.enabled}
  indexable={true}
  ogImage={null}
  canonical={canonical}
  repoUrl={data.config.repoUrl}
  askEnabled={${options.askEnabled}}
  exportPdf={${options.exportPdf}}
  exportEpub={${options.exportEpub}}
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

/** The literal Astro hydration directive for an island's client mode. */
const islandDirective = (spec: IslandSpec): string =>
  spec.client === "only"
    ? `client:only="${spec.framework}"`
    : `client:${spec.client}`;

/**
 * Generate `.blume/src/generated/islands/<Name>.astro` — a wrapper that renders
 * a convention island with its hydration directive applied. Astro client
 * directives must be written statically, so one wrapper is emitted per island;
 * props and the default slot (MDX children) forward through.
 */
export const islandWrapperTemplate = (spec: IslandSpec): string =>
  `---
// Generated by Blume. Do not edit.
import Island from ${JSON.stringify(spec.file)};
---
<Island ${islandDirective(spec)} {...Astro.props}><slot /></Island>
`;

/**
 * Generate `.blume/src/generated/islands.ts` — the map of island names to their
 * wrappers, spread into the MDX component scope by the catch-all page. Always
 * written (an empty map when there are no islands) so the import resolves.
 */
export const islandMapTemplate = (specs: IslandSpec[]): string => {
  if (specs.length === 0) {
    return `// Generated by Blume. Do not edit.
export const islandComponents = {};
`;
  }
  const imports = specs
    .map(
      (spec, index) => `import I${index} from "./islands/${spec.name}.astro";`
    )
    .join("\n");
  const entries = specs
    .map((spec, index) => `  ${spec.name}: I${index},`)
    .join("\n");
  return `// Generated by Blume. Do not edit.
${imports}
export const islandComponents = {
${entries}
};
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
