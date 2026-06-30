import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { resolveAskBackend } from "../src/ai/ask.ts";
import type { ExampleSpec } from "../src/astro/examples.ts";
import type { IslandSpec } from "../src/astro/islands.ts";
import {
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  changelogIndexTemplate,
  contentConfigTemplate,
  envTemplate,
  exampleMapTemplate,
  exampleSlug,
  exampleWrapperTemplate,
  islandMapTemplate,
  islandWrapperTemplate,
  mcpEndpointTemplate,
  mcpPageFile,
  mixedbreadSearchEndpointTemplate,
  ogEndpointTemplate,
  rawMarkdownEndpointTemplate,
  rssEndpointTemplate,
  runtimeDependencies,
  runtimePackageTemplate,
  runtimeTsconfigTemplate,
  scalarReferenceTemplate,
  searchClientTemplate,
  searchEndpointTemplate,
  stagedContentDir,
  staticJsonEndpointTemplate,
  userComponentsTemplate,
} from "../src/astro/templates.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ProjectContext } from "../src/core/types.ts";

const config = blumeConfigSchema.parse({});

const DATA_PATH = "/p/.blume/src/generated/data.json";
const EXAMPLES_PATH = "/p/.blume/src/generated/examples.ts";
const SEARCH_CLIENT_PATH = "/p/.blume/src/generated/search-client.ts";
const THEME_PATH = "/p/.blume/src/generated/app.css";

const context = (over: Partial<ProjectContext> = {}): ProjectContext => ({
  componentsFile: null,
  configFile: null,
  contentRoot: "/p/docs",
  outDir: "/p/.blume",
  pagesRoot: null,
  root: "/p",
  themeFile: null,
  ...over,
});

// A parsed config whose `ai.ask` block is always present, so resolveAskBackend
// receives a fully-resolved (schema-defaulted) backend config.
const askConfig = (ask: Record<string, unknown>) =>
  blumeConfigSchema.parse({ ai: { ask } }).ai.ask;

const withProvider = (search: Record<string, unknown>) =>
  blumeConfigSchema.parse({ search });

const island = (over: Partial<IslandSpec> = {}): IslandSpec => ({
  client: "visible",
  file: "/project/islands/Counter.tsx",
  framework: "react",
  name: "Counter",
  ...over,
});

const example = (over: Partial<ExampleSpec> = {}): ExampleSpec => ({
  client: "visible",
  file: "/project/examples/counter.tsx",
  framework: "react",
  lang: "tsx",
  path: "counter",
  source: "export default function Counter() {}",
  ...over,
});

const exportOpts = { askEnabled: false, exportEpub: false, exportPdf: false };

describe("userComponentsTemplate", () => {
  it("exports empty override maps when no components file exists", () => {
    const out = userComponentsTemplate(null);
    expect(out).toContain("export const mdxComponents = {}");
    expect(out).toContain("export const layoutOverrides = {}");
  });

  it("re-exports mdx and layout overrides from the user file", () => {
    const out = userComponentsTemplate("../../components.ts");
    expect(out).toContain('import overrides from "../../components.ts"');
    expect(out).toContain("export const mdxComponents = overrides.mdx ?? {}");
    expect(out).toContain(
      "export const layoutOverrides = overrides.layout ?? {}"
    );
  });
});

describe("catchAllPageTemplate", () => {
  it("imports layout overrides and passes them to RootLayout", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).toContain(
      'import { mdxComponents as userMdx, layoutOverrides } from "../generated/components.ts"'
    );
    expect(out).toContain("layout={layoutOverrides}");
  });

  it("imports the island map and spreads it into the MDX scope", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).toContain(
      'import { islandComponents } from "../generated/islands.ts"'
    );
    expect(out).toContain("...islandComponents,");
  });

  it("no longer imports the removed Warning component", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).not.toContain("Warning");
  });

  it("registers the Component and Diff content components", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).toContain(
      'import Component from "blume/components/content/Component.astro"'
    );
    expect(out).toContain(
      'import Diff from "blume/components/content/Diff.astro"'
    );
    expect(out).toContain("Component,");
    expect(out).toContain("Diff,");
  });

  it("imports Math and AskAI when those features are on", () => {
    const out = catchAllPageTemplate({
      askEnabled: true,
      exportEpub: true,
      exportPdf: true,
      mathEnabled: true,
    });
    expect(out).toContain(
      'import Math from "blume/components/content/Math.astro"'
    );
    expect(out).toContain(
      'import AskAI from "blume/components/islands/AskAI.astro"'
    );
    expect(out).toContain('<AskAI slot="ask"');
    expect(out).toContain("Math,");
    expect(out).toContain("askEnabled={true}");
    expect(out).toContain("exportPdf={true}");
    expect(out).toContain("exportEpub={true}");
  });
});

describe("islandWrapperTemplate", () => {
  it("applies the default visible directive and forwards props + slot", () => {
    const out = islandWrapperTemplate(island());
    expect(out).toContain('import Island from "/project/islands/Counter.tsx"');
    expect(out).toContain(
      "<Island client:visible {...Astro.props}><slot /></Island>"
    );
  });

  it("applies client:load", () => {
    expect(islandWrapperTemplate(island({ client: "load" }))).toContain(
      "<Island client:load {...Astro.props}>"
    );
  });

  it("applies client:only with the framework name", () => {
    expect(islandWrapperTemplate(island({ client: "only" }))).toContain(
      '<Island client:only="react" {...Astro.props}>'
    );
  });

  it("uses the island's framework for client:only (Vue)", () => {
    expect(
      islandWrapperTemplate(island({ client: "only", framework: "vue" }))
    ).toContain('<Island client:only="vue" {...Astro.props}>');
  });
});

describe("islandMapTemplate", () => {
  it("exports an empty map when there are no islands", () => {
    expect(islandMapTemplate([])).toContain(
      "export const islandComponents = {}"
    );
  });

  it("imports each wrapper and maps it by name", () => {
    const out = islandMapTemplate([island(), island({ name: "Chart" })]);
    expect(out).toContain('import I0 from "./islands/Counter.astro"');
    expect(out).toContain('import I1 from "./islands/Chart.astro"');
    expect(out).toContain("Counter: I0,");
    expect(out).toContain("Chart: I1,");
  });
});

describe("exampleSlug", () => {
  it("replaces path separators and unsafe characters", () => {
    expect(exampleSlug("forms/login")).toBe("forms__login");
    expect(exampleSlug("a/b-c")).toBe("a__b-c");
  });
});

describe("exampleWrapperTemplate", () => {
  it("applies the framework's hydration directive and forwards props", () => {
    const out = exampleWrapperTemplate(example());
    expect(out).toContain(
      'import Example from "/project/examples/counter.tsx"'
    );
    expect(out).toContain(
      "<Example client:visible {...Astro.props}><slot /></Example>"
    );
  });

  it("applies client:only with the framework name", () => {
    expect(
      exampleWrapperTemplate(example({ client: "only", framework: "vue" }))
    ).toContain('<Example client:only="vue" {...Astro.props}>');
  });

  it("emits no client directive for an astro example", () => {
    const out = exampleWrapperTemplate(
      example({ client: undefined, framework: "astro", lang: "astro" })
    );
    expect(out).toContain("<Example {...Astro.props}><slot /></Example>");
    expect(out).not.toContain("client:");
  });
});

describe("exampleMapTemplate", () => {
  it("exports an empty map when there are no examples", () => {
    expect(exampleMapTemplate([])).toContain("export const examples = {}");
  });

  it("maps each path to its wrapper, source, and language", () => {
    const out = exampleMapTemplate([
      example(),
      example({ lang: "astro", path: "forms/login" }),
    ]);
    expect(out).toContain('import E0 from "./examples/counter.astro"');
    expect(out).toContain('import E1 from "./examples/forms__login.astro"');
    expect(out).toContain('"counter": { Component: E0,');
    expect(out).toContain('"forms/login": { Component: E1,');
    expect(out).toContain('lang: "tsx"');
  });
});

describe("changelogIndexTemplate", () => {
  it("imports layout overrides and passes them to RootLayout", () => {
    const out = changelogIndexTemplate(exportOpts);
    expect(out).toContain(
      'import { layoutOverrides } from "../generated/components.ts"'
    );
    expect(out).toContain("layout={layoutOverrides}");
  });

  it("includes the AskAI slot when ask is enabled", () => {
    const out = changelogIndexTemplate({
      askEnabled: true,
      exportEpub: false,
      exportPdf: false,
    });
    expect(out).toContain(
      'import AskAI from "blume/components/islands/AskAI.astro"'
    );
    expect(out).toContain('<AskAI slot="ask"');
  });
});

describe("runtimeDependencies", () => {
  it("adds the Vue/Svelte integrations only when an island needs them", () => {
    expect(
      runtimeDependencies({ config, needsReact: false, needsVue: true })
    ).toContain("@astrojs/vue");
    expect(
      runtimeDependencies({ config, needsReact: false, needsSvelte: true })
    ).toContain("@astrojs/svelte");
  });

  it("omits framework integrations when no island needs them", () => {
    const deps = runtimeDependencies({ config, needsReact: false });
    expect(deps).not.toContain("@astrojs/vue");
    expect(deps).not.toContain("@astrojs/svelte");
    expect(deps).not.toContain("@astrojs/react");
  });

  it("declares the React, Scalar and Ask provider deps", () => {
    const full = blumeConfigSchema.parse({
      ai: { ask: { enabled: true, provider: "openrouter" } },
      openapi: { enabled: true },
    });
    const deps = runtimeDependencies({ config: full, needsReact: true });
    expect(deps).toContain("@astrojs/react");
    expect(deps).toContain("@scalar/astro");
    expect(deps).toContain("@openrouter/ai-sdk-provider");
  });

  it("adds the server adapter dependency", () => {
    const server = blumeConfigSchema.parse({
      deployment: { adapter: "vercel", output: "server" },
    });
    expect(
      runtimeDependencies({ config: server, needsReact: false })
    ).toContain("@astrojs/vercel");
  });
});

describe("astroConfigTemplate", () => {
  it("emits a static config with fonts and no framework renderers by default", () => {
    const out = astroConfigTemplate({
      config,
      contentRoutes: ["/"],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('output: "static"');
    expect(out).toContain("fontProviders.google()");
    expect(out).toContain(
      'import { defineConfig, fontProviders } from "astro/config"'
    );
    expect(out).not.toContain('import react from "@astrojs/react"');
    expect(out).toContain("blumeIntegration(");
    expect(out).not.toContain("adapter:");
    expect(out).toContain(`"blume:examples": ${JSON.stringify(EXAMPLES_PATH)}`);
  });

  it("wires the adapter, site, base, redirects, i18n and renderers", () => {
    const serverConfig = blumeConfigSchema.parse({
      deployment: {
        adapter: "node",
        base: "/docs",
        output: "server",
        site: "https://x.com",
      },
      i18n: {
        defaultLocale: "en",
        hideDefaultLocalePrefix: false,
        locales: [{ code: "en", label: "English" }],
      },
      redirects: [{ from: "/old", to: "/new" }],
    });
    const out = astroConfigTemplate({
      config: serverConfig,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      needsReact: true,
      needsSvelte: true,
      needsVue: true,
      pages: [{ entrypoint: "/p/pages/x.astro", pattern: "/x" }],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import adapter from "@astrojs/node"');
    expect(out).toContain('adapter: adapter({ mode: "standalone" })');
    expect(out).toContain('site: "https://x.com"');
    expect(out).toContain('base: "/docs"');
    expect(out).toContain("redirects:");
    expect(out).toContain('"/old"');
    expect(out).toContain("i18n:");
    expect(out).toContain('"prefixDefaultLocale":true');
    expect(out).toContain('import react from "@astrojs/react"');
    expect(out).toContain('import vue from "@astrojs/vue"');
    expect(out).toContain('import svelte from "@astrojs/svelte"');
    expect(out).toContain("react()");
    expect(out).toContain("vue()");
    expect(out).toContain("svelte()");
  });

  it("omits adapter options for adapters that need none", () => {
    const vercelConfig = blumeConfigSchema.parse({
      deployment: { adapter: "vercel", output: "server" },
    });
    const out = astroConfigTemplate({
      config: vercelConfig,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import adapter from "@astrojs/vercel"');
    expect(out).toContain("adapter: adapter(),");
  });
});

describe("astroConfigTemplate workspace root", () => {
  const dirs: string[] = [];

  const makeRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "blume-tpl-"));
    dirs.push(root);
    return root;
  };

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  const fsAllowFor = (root: string): string => {
    const out = astroConfigTemplate({
      config,
      contentRoutes: [],
      context: context({
        contentRoot: join(root, "docs"),
        outDir: join(root, ".blume"),
        root,
      }),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    return out;
  };

  it("uses a package.json workspaces field as the workspace root", async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] })
    );
    expect(fsAllowFor(root)).toContain(JSON.stringify([root]));
  });

  it("falls back to filesystem markers when package.json is unparseable", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "package.json"), "{ not json");
    await mkdir(join(root, ".git"), { recursive: true });
    expect(fsAllowFor(root)).toContain(JSON.stringify([root]));
  });
});

describe("contentConfigTemplate", () => {
  it("emits only the docs collection without staged sources", () => {
    const out = contentConfigTemplate({ config, context: context() });
    expect(out).toContain("const docs = defineCollection(");
    expect(out).not.toContain("const staged");
    expect(out).toContain("export const collections = { docs };");
  });

  it("adds a staged collection when staged sources materialize", () => {
    const out = contentConfigTemplate({
      config,
      context: context(),
      staged: true,
    });
    expect(out).toContain("const staged = defineCollection(");
    expect(out).toContain("export const collections = { docs, staged };");
  });

  it("honors an explicit staged base directory", () => {
    const out = contentConfigTemplate({
      config,
      context: context(),
      staged: true,
      stagedBase: "/custom/base",
    });
    expect(out).toContain('"/custom/base"');
  });
});

describe("stagedContentDir", () => {
  it("joins content under the outDir", () => {
    expect(stagedContentDir("/p/.blume")).toBe("/p/.blume/content");
  });
});

describe("askEndpointTemplate", () => {
  it("uses the AI gateway (core model id) by default", () => {
    const out = askEndpointTemplate(resolveAskBackend());
    expect(out).toContain('import { streamText } from "ai"');
    expect(out).toContain('model: "openai/gpt-5.5"');
    expect(out).not.toContain("createOpenRouter");
  });

  it("wires the OpenRouter provider", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(
        askConfig({
          apiKeyEnv: "OR_KEY",
          enabled: true,
          model: "x/y",
          provider: "openrouter",
        })
      )
    );
    expect(out).toContain("createOpenRouter");
    expect(out).toContain('process.env["OR_KEY"]');
    expect(out).toContain('openrouter("x/y")');
  });

  it("wires an OpenAI-compatible provider", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(
        askConfig({
          baseUrl: "https://api.example.com/v1",
          enabled: true,
          model: "m",
          provider: "openai-compatible",
        })
      )
    );
    expect(out).toContain("createOpenAICompatible");
    expect(out).toContain('baseURL: "https://api.example.com/v1"');
    expect(out).toContain('provider("m")');
  });
});

describe("searchClientTemplate", () => {
  it("loads a static index for orama", () => {
    expect(searchClientTemplate(withProvider({ provider: "orama" }))).toContain(
      "search/orama.ts"
    );
  });

  it("loads a static index for flexsearch", () => {
    expect(
      searchClientTemplate(withProvider({ provider: "flexsearch" }))
    ).toContain("search/flexsearch.ts");
  });

  it("passes algolia credentials to the hosted client", () => {
    const out = searchClientTemplate(
      withProvider({
        algolia: { appId: "A", indexName: "I", searchApiKey: "K" },
        provider: "algolia",
      })
    );
    expect(out).toContain("search/algolia.ts");
    expect(out).toContain('"appId":"A"');
  });

  it("passes orama-cloud credentials to the hosted client", () => {
    const out = searchClientTemplate(
      withProvider({
        oramaCloud: { apiKey: "K", endpoint: "https://e" },
        provider: "orama-cloud",
      })
    );
    expect(out).toContain("search/orama-cloud.ts");
    expect(out).toContain('"endpoint":"https://e"');
  });

  it("passes typesense credentials to the hosted client", () => {
    const out = searchClientTemplate(
      withProvider({
        provider: "typesense",
        typesense: { collection: "c", host: "h", searchApiKey: "K" },
      })
    );
    expect(out).toContain("search/typesense.ts");
  });

  it("points mixedbread at the server endpoint", () => {
    const out = searchClientTemplate(
      withProvider({ mixedbread: { storeId: "s" }, provider: "mixedbread" })
    );
    expect(out).toContain("search/endpoint.ts");
    expect(out).toContain("api/search");
  });

  it("loads pagefind from the build output", () => {
    const out = searchClientTemplate(withProvider({ provider: "pagefind" }));
    expect(out).toContain("search/pagefind.ts");
    expect(out).toContain("pagefind/pagefind.js");
  });

  it("emits a no-op client when search is disabled", () => {
    const out = searchClientTemplate(withProvider({ provider: "none" }));
    expect(out).toContain("hits: [], sections: []");
  });
});

describe("scalarReferenceTemplate", () => {
  it("mounts a Scalar reference inside the Blume layout", () => {
    const out = scalarReferenceTemplate({
      configuration: { url: "https://api/spec.json" },
      dataImport: "../generated/data.json",
      route: "/reference",
      title: "API",
    });
    expect(out).toContain("ScalarComponent");
    expect(out).toContain('import data from "../generated/data.json"');
    expect(out).toContain('route={"/reference"}');
    expect(out).toContain('"url": "https://api/spec.json"');
  });
});

describe("mcp templates", () => {
  it("strips leading and trailing slashes for the page file", () => {
    expect(mcpPageFile("/mcp")).toBe("mcp.ts");
    expect(mcpPageFile("/api/mcp/")).toBe("api/mcp.ts");
  });

  it("imports the data snapshot at the route's depth", () => {
    expect(mcpEndpointTemplate("/mcp")).toContain(
      'import data from "../generated/mcp-data.json"'
    );
    expect(mcpEndpointTemplate("/api/mcp")).toContain(
      'import data from "../../generated/mcp-data.json"'
    );
  });

  it("serializes a fixed payload for the discovery endpoint", () => {
    const out = staticJsonEndpointTemplate({ ok: true });
    expect(out).toContain("export const prerender = true;");
    expect(out).toContain('"ok": true');
  });
});

describe("static endpoint templates", () => {
  it("serves the static search index", () => {
    expect(searchEndpointTemplate()).toContain(
      'import documents from "../generated/search.json"'
    );
  });

  it("proxies mixedbread queries with the store id", () => {
    const out = mixedbreadSearchEndpointTemplate("store_42");
    expect(out).toContain('const STORE_ID = "store_42"');
    expect(out).toContain("client.stores.search");
  });

  it("serves raw markdown verbatim", () => {
    expect(rawMarkdownEndpointTemplate()).toContain("text/markdown");
  });

  it("renders the OG image endpoint", () => {
    expect(ogEndpointTemplate()).toContain("renderOgImage");
  });

  it("serves one RSS feed per section", () => {
    expect(rssEndpointTemplate()).toContain("application/rss+xml");
  });
});

describe("env / package / tsconfig templates", () => {
  it("references the Astro client types", () => {
    expect(envTemplate()).toContain('types="astro/client"');
  });

  it("types the blume:data module from the public BlumeData type", () => {
    const out = envTemplate();
    expect(out).toContain('declare module "blume:data"');
    expect(out).toContain('import("blume").BlumeData');
  });

  it("emits an empty dependency map by default", () => {
    expect(runtimePackageTemplate()).toContain('"dependencies": {}');
  });

  it("sorts declared dependencies", () => {
    const out = runtimePackageTemplate(["zzz", "aaa"]);
    expect(out.indexOf('"aaa"')).toBeLessThan(out.indexOf('"zzz"'));
  });

  it("extends the strict Astro tsconfig", () => {
    expect(runtimeTsconfigTemplate()).toContain(
      '"extends": "astro/tsconfigs/strict"'
    );
  });
});
