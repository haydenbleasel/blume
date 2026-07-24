import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import { resolveAskBackend } from "../src/ai/ask.ts";
import type { ExampleSpec } from "../src/astro/examples.ts";
import type { IslandSpec } from "../src/astro/islands.ts";
import {
  askComponentTemplate,
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  changelogIndexTemplate,
  contentConfigTemplate,
  envTemplate,
  exampleMapTemplate,
  exampleSlug,
  examplesPageTemplate,
  exampleWrapperTemplate,
  islandMapTemplate,
  islandWrapperTemplate,
  mcpEndpointTemplate,
  mcpPageFile,
  mixedbreadSearchEndpointTemplate,
  notFoundPageTemplate,
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
} from "../src/astro/templates.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ProjectContext } from "../src/core/types.ts";

const config = blumeConfigSchema.parse({});

const ASK_PATH = "/p/.blume/src/generated/Ask.astro";
const DATA_PATH = "/p/.blume/src/generated/data.json";
const EXAMPLES_PATH = "/p/.blume/src/generated/examples.ts";
const EXAMPLES_THEME_PATH = "/p/.blume/src/generated/examples.css";
const OPENAPI_PATH = "/p/.blume/src/generated/openapi.json";
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

const exportOpts = {
  exportEpub: false,
  exportPdf: false,
  needsReact: false,
};

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

  it("serializes the island-hooks snapshot only when React is enabled", () => {
    const off = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(off).not.toContain("clientData=");
    const on = catchAllPageTemplate({
      ...exportOpts,
      mathEnabled: false,
      needsReact: true,
    });
    expect(on).toContain("clientData={{ config: data.config");
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

  it("registers the YouTube content component", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).toContain(
      'import YouTube from "blume/components/content/YouTube.astro"'
    );
    expect(out).toContain("YouTube,");
  });

  it("imports Math when the feature is on", () => {
    const out = catchAllPageTemplate({
      exportEpub: true,
      exportPdf: true,
      mathEnabled: true,
      needsReact: false,
    });
    expect(out).toContain(
      'import Math from "blume/components/content/Math.astro"'
    );
    expect(out).toContain("Math,");
    expect(out).toContain("exportPdf={true}");
    expect(out).toContain("exportEpub={true}");
  });

  // The Ask AI trigger is the shared header's, not the page's — see
  // askComponentTemplate. A page that wired up its own would double-render it.
  it("leaves the Ask AI trigger to the header", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: true });
    expect(out).not.toContain("AskAI");
    expect(out).not.toContain("askEnabled");
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

  // Without a `Props` alias the spread contributes nothing to the JSX props
  // type, so an island with a required prop fails `astro check` (#91).
  it("types Props from the island so required props type-check", () => {
    const out = islandWrapperTemplate(island());
    expect(out).toContain("type Props = typeof Island extends (");
    expect(out).toContain("infer P extends object");
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
  it("hex-escapes every non-alphanumeric character", () => {
    expect(exampleSlug("forms/login")).toBe("forms_2f_login");
    expect(exampleSlug("a/b-c")).toBe("a_2f_b_2d_c");
  });

  it("never collides distinct paths onto one wrapper file", () => {
    // `button.demo` and `button-demo` used to both slug to `button-demo`,
    // making one example render the other's component.
    expect(exampleSlug("button.demo")).not.toBe(exampleSlug("button-demo"));
    expect(exampleSlug("a/b")).not.toBe(exampleSlug("a__b"));
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
      // An astro example has no client directive; client is optional, so this
      // clears the factory default with undefined rather than null.
      // oxlint-disable-next-line sonarjs/no-undefined-assignment
      example({ client: undefined, framework: "astro", lang: "astro" })
    );
    expect(out).toContain("<Example {...Astro.props}><slot /></Example>");
    expect(out).not.toContain("client:");
  });

  it("types Props from the example so required props type-check", () => {
    expect(exampleWrapperTemplate(example())).toContain(
      "type Props = typeof Example extends ("
    );
  });
});

describe("exampleMapTemplate", () => {
  it("exports an empty map (and the route base) when there are no examples", () => {
    const out = exampleMapTemplate([], "");
    expect(out).toContain("export const examples = {}");
    expect(out).toContain('export const examplesBase = "/blume-examples"');
  });

  it("nests the route base under basePath", () => {
    expect(exampleMapTemplate([], "/docs")).toContain(
      'export const examplesBase = "/docs/blume-examples"'
    );
  });

  it("maps each path to its wrapper, source, and language", () => {
    const out = exampleMapTemplate(
      [example(), example({ lang: "astro", path: "forms/login" })],
      ""
    );
    expect(out).toContain('import E0 from "./examples/counter.astro"');
    expect(out).toContain('import E1 from "./examples/forms_2f_login.astro"');
    expect(out).toContain('"counter": { Component: E0,');
    expect(out).toContain('"forms/login": { Component: E1,');
    expect(out).toContain('lang: "tsx"');
  });
});

describe("examplesPageTemplate", () => {
  const out = examplesPageTemplate();

  it("renders a bare prerendered route per example with only the example sheet", () => {
    expect(out).toContain('import { examples } from "blume:examples"');
    expect(out).toContain('import "blume:examples-theme"');
    expect(out).toContain("export const prerender = true");
    expect(out).toContain("getStaticPaths");
    // The whole point is isolation: no layout, no docs theme.
    expect(out).not.toContain("RootLayout");
    expect(out).not.toContain('"blume:theme"');
  });

  it("mirrors the parent theme before paint and stays out of search results", () => {
    expect(out).toContain("window.parent.document.documentElement");
    expect(out).toContain("MutationObserver");
    // Both dark-mode conventions, for Blume tokens and shadcn-style CSS alike.
    expect(out).toContain("root.dataset.theme = theme");
    expect(out).toContain('root.classList.toggle("dark"');
    expect(out).toContain('<meta name="robots" content="noindex" />');
  });

  it("reports the example's rendered height to the embedding page", () => {
    // The docs page sizes the preview pane from this report, so the wrapper
    // marker, the observer, and the message type all need to survive edits.
    expect(out).toContain("<div data-blume-example");
    expect(out).toContain("ResizeObserver");
    expect(out).toContain('type: "blume:example-height"');
    // The body padding folded into the report is read from the live value,
    // not hardcoded — a root font-size override in the user's examples.css
    // must not skew the report.
    expect(out).toContain("getComputedStyle(document.body)");
    // Pinned to the docs origin — never a wildcard target.
    expect(out).toContain("window.location.origin");
    expect(out).not.toContain('"*"');
  });
});

describe("changelogIndexTemplate", () => {
  it("imports layout overrides and passes them to RootLayout", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    expect(out).toContain(
      'import { layoutOverrides } from "../generated/components.ts"'
    );
    expect(out).toContain("layout={layoutOverrides}");
  });

  it("reads only the docs collection when no staged sources exist", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    expect(out).toContain('...(await getCollection("docs")),');
    expect(out).not.toContain('getCollection("staged")');
  });

  it("folds in the staged collection when staged sources exist", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: true });
    expect(out).toContain('...(await getCollection("docs")),');
    expect(out).toContain('...(await getCollection("staged")),');
  });

  it("leaves the Ask AI trigger to the header", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    expect(out).not.toContain("AskAI");
    expect(out).not.toContain("askEnabled");
  });

  it("renders through the sidebar-less, TOC-less bare layout", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    expect(out).toContain('contentLayout="bare"');
  });

  it("canonicalizes under the deployment base, like the catch-all", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    expect(out).toContain(
      'import { withBase } from "blume/components/islands/base-path.ts"'
    );
    expect(out).toContain('const basedRoute = withBase("/changelog");');
    expect(out).toContain("const canonical = base ? base + basedRoute : null;");
  });

  it("links each timeline heading to its own generated page", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    // Route lookup keyed by the collection entry id (matches the manifest).
    expect(out).toContain(
      "data.routes.map((route) => [route.entryId, route.path])"
    );
    expect(out).toContain("href: routeByEntry.get(entry.id) ?? undefined");
    expect(out).toContain("href={href}");
  });

  it("timeline heading links resolve under the deployment base", async () => {
    // The template passes deploy-base-less routes; Update.astro rebases at
    // emit time like a markdown link (composed deployment.base + basePath,
    // idempotent per layer), and pure-anchor `#id` fallbacks pass through.
    const source = await readFile(
      new URL("../src/components/content/Update.astro", import.meta.url),
      "utf-8"
    );
    expect(source).toContain('import { contentHref } from "./base-href.ts"');
    expect(source).toContain(`href={contentHref(href ?? \`#\${id}\`)}`);
  });

  it("suffixes repeated heading slugs so each entry keeps its own anchor", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    const start = out.indexOf("const seenIds");
    const end = out.indexOf("// A changelog is semver-paginated");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // The headings list is built after the dedupe pass, so the rendered ids
    // and the TOC slugs stay in agreement.
    expect(out.indexOf("const headings")).toBeGreaterThan(end);
    // Run the generated dedupe pass to pin its behavior.
    // oxlint-disable-next-line no-new-func -- evaluating our own generated output
    const dedupe = new Function(
      "items",
      `${out.slice(start, end)}\nreturn items.map((item) => item.id);`
    ) as (items: { id: string }[]) => string[];
    const ids = (...slugs: string[]) => dedupe(slugs.map((id) => ({ id })));
    expect(ids("v1", "v2")).toEqual(["v1", "v2"]);
    expect(ids("update", "update", "update")).toEqual([
      "update",
      "update-2",
      "update-3",
    ]);
    // A generated suffix never collides with a later natural slug.
    expect(ids("v1", "v1", "v1-2")).toEqual(["v1", "v1-2", "v1-2-2"]);
  });

  it("passes the resolved UI dictionary and default-locale lang/dir to the layout", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    // Mirrors the catch-all: default locale under i18n, English baseline
    // otherwise, so /changelog chrome doesn't revert to EN_UI / dir="ltr".
    expect(out).toContain('const htmlLang = i18n ? i18n.defaultLocale : "en";');
    expect(out).toContain('const dir = localeMeta?.dir ?? "ltr";');
    expect(out).toContain("locale={htmlLang}");
    expect(out).toContain("dir={dir}");
    expect(out).toContain("ui={data.ui}");
  });

  it("localizes the changelog heading, page title, and description", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    // The chrome comes from the same translatable `changelog` group as the
    // reveal button, with English fallback for a stale data snapshot.
    expect(out).toContain(
      'const changelogTitle = data.ui.changelog?.title ?? "Changelog";'
    );
    expect(out).toContain(
      'data.ui.changelog?.description ??\n  "Product updates, new features, and fixes from every release.";'
    );
    expect(out).toContain(
      'const pageTitle = data.config.title + " " + changelogTitle;'
    );
    expect(out).toContain("<h1>{changelogTitle}</h1>");
    expect(out).toContain("description: changelogDescription,");
    expect(out).not.toContain("<h1>Changelog</h1>");
    // The island-hooks snapshot reuses the same localized page title.
    const reactOut = changelogIndexTemplate({
      ...exportOpts,
      needsReact: true,
      staged: false,
    });
    expect(reactOut).toContain(
      'page: { route: "/changelog", title: pageTitle }'
    );
  });

  it("paginates by major version when the releases are semver", () => {
    const out = changelogIndexTemplate({ ...exportOpts, staged: false });
    // Detects a full major.minor.patch and groups older majors behind a button.
    expect(out).toContain("const majorVersion");
    expect(out).toContain("const paginate = majors.length > 1");
    expect(out).toContain("<blume-changelog");
    expect(out).toContain("data-changelog-major={group.major}");
    expect(out).toContain("data-changelog-more");
    // The reveal button's label comes from the translatable UI dictionary.
    expect(out).toContain("data-i18n-more={data.ui.changelog?.showReleases}");
    // The progressive-reveal element is loaded on the changelog page.
    expect(out).toContain(
      'import "blume/components/content/changelog-element.ts"'
    );
  });
});

describe("notFoundPageTemplate", () => {
  it("renders through PageLayout, prerendered and noindex", () => {
    const out = notFoundPageTemplate();
    expect(out).toContain(
      'import PageLayout from "blume/components/layout/PageLayout.astro"'
    );
    expect(out).toContain("export const prerender = true;");
    expect(out).toContain("noindex={true}");
  });

  it("pulls its copy from the translatable notFound UI strings", () => {
    const out = notFoundPageTemplate();
    expect(out).toContain("const nf = data.ui.notFound;");
    expect(out).toContain("{nf.title}");
    expect(out).toContain("{nf.description}");
    expect(out).toContain("{nf.home}");
  });

  it("routes the home link through withBase, like the catch-all", () => {
    const out = notFoundPageTemplate();
    expect(out).toContain(
      'import { withBase } from "blume/components/islands/base-path.ts"'
    );
    expect(out).toContain('href={withBase("/")}');
  });

  it("passes default-locale lang/dir with the UI dictionary, like the catch-all", () => {
    const out = notFoundPageTemplate();
    expect(out).toContain('const htmlLang = i18n ? i18n.defaultLocale : "en";');
    expect(out).toContain('const dir = localeMeta?.dir ?? "ltr";');
    expect(out).toContain("locale={htmlLang}");
    expect(out).toContain("dir={dir}");
    expect(out).toContain("ui={data.ui}");
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
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/openapi.json",
      },
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

  it("never declares the React Compiler plugin as a runtime dep (it's resolved by absolute path)", () => {
    expect(runtimeDependencies({ config, needsReact: true })).not.toContain(
      "babel-plugin-react-compiler"
    );
  });
});

describe("askComponentTemplate", () => {
  it("renders the island, taking its suggestions from the data snapshot", () => {
    const out = askComponentTemplate(true);
    expect(out).toContain(
      'import AskAI from "blume/components/islands/AskAI.astro"'
    );
    expect(out).toContain("<AskAI");
    expect(out).toContain("data.config.ask?.suggestions ?? []");
  });

  // The reason this component exists: the header imports it unconditionally, so
  // when Ask is off it must not drag React into a project that has no React
  // renderer wired into its generated Astro config.
  it("imports no island when ask is off, and renders nothing", () => {
    const out = askComponentTemplate(false);
    expect(out).not.toContain("AskAI");
    expect(out).not.toMatch(/^import /mu);
    expect(out.replaceAll(/^---$[\S\s]*?^---$/gmu, "").trim()).toBe("");
  });
});

describe("astroConfigTemplate", () => {
  it("emits a static config with fonts and no framework renderers by default", () => {
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
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
    // The prerender dep-link plugin is wired into the Vite config so isolated
    // linkers can resolve externalized deps when generating static pages, and the
    // server-app resolve shim keeps dev full reloads (route renames) from
    // corrupting Astro's SSR module runner.
    expect(out).toContain(
      'import { blumeIntegration, prerenderDepsPlugin, serverAppResolvePlugin } from "blume/astro"'
    );
    expect(out).toContain("prerenderDepsPlugin()");
    expect(out).toContain("serverAppResolvePlugin()");
    // Both lazy client-side deps are pre-bundled through the `blume` package so
    // their CJS/UMD entries get ESM interop in dev; the nested form is required
    // because neither is a direct dep of the generated project, and
    // epub-gen-memory names the `/bundle` subpath it actually imports — the
    // package root would leave that entry unoptimized. See the optimizeDeps
    // comment.
    expect(out).toContain(
      'include: ["blume > mermaid", "blume > epub-gen-memory/bundle"]'
    );
    // Blume's render-time deps are forced external on both build environments so
    // native bindings load at runtime and isolated linkers don't bundle (and
    // strand the children of) symlinked store copies.
    expect(out).toContain('"takumi-js"');
    // The `takumi-js/helpers` subpath (OG `googleFonts` loader) and the native
    // `@takumi-rs/core` backend must be external too: the prerender env matches
    // by exact specifier, so a bare `takumi-js` alone lets the subpath — and the
    // native binding it drags in — get bundled, breaking OG on Linux/Vercel.
    expect(out).toContain('"takumi-js/helpers"');
    expect(out).toContain('"@takumi-rs/core"');
    expect(out).toContain('"@astrojs/markdown-satteri"');
    expect(out).toMatch(/prerender: \{ resolve: \{ external: \[/u);
    // SSR externals use the legacy `ssr.external` key, not `environments.ssr`: a
    // user-owned `environments.ssr` block collides with the internal environment
    // Astro 7 builds the server under and mis-names the adapter's server entry.
    expect(out).toMatch(/ssr: \{ external: \[/u);
    expect(out).not.toMatch(/environments: \{[^}]*ssr:/su);
    expect(out).not.toContain("adapter:");
    expect(out).toContain(`"blume:examples": ${JSON.stringify(EXAMPLES_PATH)}`);
    expect(out).toContain(
      `"blume:examples-theme": ${JSON.stringify(EXAMPLES_THEME_PATH)}`
    );
    // The dev watcher must see Astro's cache dir: change events on
    // `.astro/data-store.json` are the only trigger for Astro's dev-time
    // content invalidation, and `.md` bodies are rendered into the store at
    // load time — ignoring it serves stale `.md` HTML until a restart.
    expect(out).not.toContain(".astro/**");
  });

  // A migrated (`.`-rooted) project's docs glob-loader watcher fires on every
  // `.blume/.astro` write ("No entry type found" noise, and a data-store.json
  // event can re-ingest the store as an entry and loop) — only there is the
  // cache dir kept out of the watcher. See the watchOption comment.
  it("ignores Astro's cache dir only when the docs collection watches the runtime dir", () => {
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      contentWatchesRuntimeDir: true,
      context: context({ contentRoot: "/p" }),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('"/p/.blume/.astro/**"');
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
      askPath: ASK_PATH,
      config: serverConfig,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: true,
      needsSvelte: true,
      needsVue: true,
      openapiPath: OPENAPI_PATH,
      pages: [{ entrypoint: "/p/pages/x.astro", pattern: "/x" }],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import adapter from "@astrojs/node"');
    expect(out).toContain('adapter: adapter({ mode: "standalone" })');
    expect(out).toContain('site: "https://x.com"');
    expect(out).toContain('base: "/docs"');
    // The deployment base reaches the markdown processors as its own layer so
    // content links are rewritten under the served URL.
    expect(out).toContain('"deployBase":"/docs"');
    expect(out).toContain("redirects:");
    expect(out).toContain('"/old"');
    expect(out).toContain("i18n:");
    expect(out).toContain('"prefixDefaultLocale":true');
    expect(out).toContain('import react from "@astrojs/react"');
    expect(out).toContain('import vue from "@astrojs/vue"');
    expect(out).toContain('import svelte from "@astrojs/svelte"');
    // No reactCompilerPath passed, so react() carries no babel block
    // (compiler off) — only the pre-bundle exclude.
    expect(out).toContain(
      String.raw`react({ exclude: [/\/node_modules\/\.vite\//] })`
    );
    expect(out).toContain("vue()");
    expect(out).toContain("svelte()");
  });

  it("writes deployment.base into a redirect destination, not into `from`", () => {
    const basedConfig = blumeConfigSchema.parse({
      basePath: "/manual",
      deployment: { base: "/docs" },
      redirects: [{ from: "/old", to: "/new" }],
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: basedConfig,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    // Astro builds the `from` pattern with `base` applied, so `from` carries
    // only `basePath` — but it never prepends `base` to a destination, so `to`
    // carries the full stack or the redirect lands outside the site.
    expect(out).toContain(
      '"/manual/old":{"destination":"/docs/manual/new","status":301}'
    );
  });

  it("threads basePath into the markdown processors and bases redirects", () => {
    const basedConfig = blumeConfigSchema.parse({
      basePath: "/manual",
      redirects: [{ from: "/old", to: "/new" }],
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: basedConfig,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    // Both processors learn the base so content links are rewritten under it.
    // `deployBase` stays a separate layer (empty here — no deployment.base) so
    // a hand-written basePath link isn't double-prefixed.
    expect(out).toContain('blumeMdxProcessor({"basePath":"/manual"');
    expect(out).toContain('blumeMarkdownProcessor({"basePath":"/manual"');
    expect(out).toContain('"deployBase":""');
    // Redirect endpoints land under the base too.
    expect(out).toContain('"/manual/old"');
    expect(out).toContain('"/manual/new"');
  });

  it("carries the React Compiler babel plugin when a compiler path is given", () => {
    const compilerPath =
      "/abs/node_modules/babel-plugin-react-compiler/dist/index.js";
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: true,
      openapiPath: OPENAPI_PATH,
      pages: [],
      reactCompilerPath: compilerPath,
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain(
      `react({ babel: { plugins: [[${JSON.stringify(compilerPath)}, { target: "19" }]] }, ${String.raw`exclude: [/\/node_modules\/\.vite\//]`} })`
    );
  });

  it("omits the compiler babel plugin when no compiler path is given", () => {
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: true,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import react from "@astrojs/react"');
    expect(out).toContain(
      String.raw`react({ exclude: [/\/node_modules\/\.vite\//] })`
    );
    expect(out).not.toContain("babel-plugin-react-compiler");
  });

  it("prerenders cloudflare adapter builds in Node so build-time node: imports resolve", () => {
    const cloudflareConfig = blumeConfigSchema.parse({
      deployment: { adapter: "cloudflare", output: "server" },
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: cloudflareConfig,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import adapter from "@astrojs/cloudflare"');
    expect(out).toContain('adapter: adapter({ prerenderEnvironment: "node" })');
  });

  it("points the cloudflare adapter configPath at a project-root wrangler config so the dev workerd runtime picks up nodejs_compat", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-cf-"));
    try {
      await writeFile(
        join(root, "wrangler.toml"),
        'compatibility_flags = ["nodejs_compat"]\n'
      );
      const cloudflareConfig = blumeConfigSchema.parse({
        deployment: { adapter: "cloudflare", output: "server" },
      });
      const out = astroConfigTemplate({
        askPath: ASK_PATH,
        config: cloudflareConfig,
        contentRoutes: [],
        context: context({
          outDir: join(root, ".blume"),
          root,
        }),
        dataPath: DATA_PATH,
        examplesPath: EXAMPLES_PATH,
        examplesThemePath: EXAMPLES_THEME_PATH,
        needsReact: false,
        openapiPath: OPENAPI_PATH,
        pages: [],
        searchClientPath: SEARCH_CLIENT_PATH,
        themePath: THEME_PATH,
      });
      expect(out).toContain(
        'adapter: adapter({ prerenderEnvironment: "node", configPath: "../wrangler.toml" })'
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("omits adapter options for adapters that need none", () => {
    const vercelConfig = blumeConfigSchema.parse({
      deployment: { adapter: "vercel", output: "server" },
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: vercelConfig,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import adapter from "@astrojs/vercel"');
    expect(out).toContain('adapter: withAdapterRoot(adapter(), "/p"),');
    expect(out).not.toContain("configPath");
  });

  it("shows the Vercel adapter the project root, not the .blume runtime", () => {
    // The adapter resolves its Build Output tree *and* its `@vercel/nft`
    // dependency trace against `root`. Rooted at `.blume`, nft's base excludes
    // `<outDir>/server`, so the traced function ships without its chunks or
    // node_modules and 500s with ERR_MODULE_NOT_FOUND on first request.
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: blumeConfigSchema.parse({
        deployment: { adapter: "vercel", output: "server" },
      }),
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    // The root handed to the adapter is the one `outDir` implies (`/p/dist` ->
    // `/p`), never Astro's real root.
    expect(out).toContain('adapter: withAdapterRoot(adapter(), "/p"),');
    expect(out).toContain('outDir: "/p/dist"');
    expect(out).not.toContain('withAdapterRoot(adapter(), "/p/.blume")');
    expect(out).toContain('withAdapterRoot } from "blume/astro"');
  });

  it("keeps an isolated build's Vercel output inside the relocated runtime", () => {
    // `blume build --isolated` relocates the runtime and its dist; the adapter
    // root must follow, so a verify build never overwrites the real
    // `<root>/.vercel/output`.
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: blumeConfigSchema.parse({
        deployment: { adapter: "vercel", output: "server" },
      }),
      contentRoutes: [],
      context: context({
        distDir: "/p/.blume-verify/dist",
        outDir: "/p/.blume-verify",
      }),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain(
      'adapter: withAdapterRoot(adapter(), "/p/.blume-verify"),'
    );
  });

  it("leaves non-Vercel adapters unwrapped", () => {
    // Only Vercel resolves a dependency trace against `root`; node is standalone
    // and cloudflare emits into `outDir`, so neither needs the override.
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: blumeConfigSchema.parse({
        deployment: { adapter: "node", output: "server" },
      }),
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('adapter: adapter({ mode: "standalone" }),');
    expect(out).not.toContain("withAdapterRoot");
  });

  it("wires project tsconfig aliases into vite resolve.alias, longest first", () => {
    const out = astroConfigTemplate({
      aliases: { "@": "/proj/src", "@ui": "/proj/src/components/ui" },
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context(),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('"@": "/proj/src"');
    expect(out).toContain('"@ui": "/proj/src/components/ui"');
    // A more specific prefix is matched before the broader one...
    expect(out.indexOf('"@ui"')).toBeLessThan(out.indexOf('"@": '));
    // ...and both follow Blume's own aliases.
    expect(out.indexOf('"blume:theme"')).toBeLessThan(out.indexOf('"@ui"'));
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
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context({
        contentRoot: join(root, "docs"),
        outDir: join(root, ".blume"),
        root,
      }),
      dataPath: DATA_PATH,
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      needsReact: false,
      openapiPath: OPENAPI_PATH,
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
    // Absolute bases are emitted as `file://` URLs (Windows drive-letter safety).
    expect(out).toContain(JSON.stringify(pathToFileURL("/custom/base").href));
  });

  it("excludes dependency, output, and cache trees from the docs glob", () => {
    // Astro's content layer roots at the project dir, so a `.`-wide content root
    // must skip the same never-content dirs the filesystem scan does — else it
    // re-ingests node_modules or a prior `dist/*.mdx` and breaks the module graph.
    const out = contentConfigTemplate({ config, context: context() });
    for (const dir of ["node_modules", "dist", ".vercel", ".git"]) {
      expect(out).toContain(`"!**/${dir}/**"`);
    }
  });

  it("excludes the runtime dir when it sits inside the content root", () => {
    // Migrated `.`-rooted project: content root is the project root with a real
    // filesystem source, so `.blume/` is nested and must be excluded.
    const out = contentConfigTemplate({
      config,
      context: context({ contentRoot: "/p", outDir: "/p/.blume" }),
      filesystem: true,
    });
    expect(out).toContain('"!.blume/**"');
  });

  it("omits the runtime-dir exclude when it is a sibling of the content root", () => {
    // Default: content root is `/p/docs`, runtime is `/p/.blume` (outside it).
    const out = contentConfigTemplate({ config, context: context() });
    expect(out).not.toContain(".blume/**");
  });

  it("globs nothing when no filesystem source feeds the docs collection", () => {
    // All-staged project: every page is staged, so the project-rooted `docs`
    // glob would only scan (and watch) `.blume/` for nothing. Empty pattern
    // keeps it — and Astro's content watcher — silent, while the collection
    // stays declared.
    const out = contentConfigTemplate({
      config,
      context: context({ contentRoot: "/p", outDir: "/p/.blume" }),
      filesystem: false,
      staged: true,
    });
    expect(out).toContain("const docs = defineCollection(");
    expect(out).toContain("pattern: []");
    expect(out).not.toContain('"!**/node_modules/**"');
    expect(out).toContain("export const collections = { docs, staged };");
  });
});

describe("stagedContentDir", () => {
  it("joins content under the outDir", () => {
    expect(stagedContentDir("/p/.blume")).toBe("/p/.blume/content");
  });
});

describe("askEndpointTemplate", () => {
  it("uses the AI gateway (core model id) by default", () => {
    const out = askEndpointTemplate(resolveAskBackend(), true);
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
      ),
      true
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
      ),
      true
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

  it("forwards the localized UI dictionary to the layout", () => {
    const out = scalarReferenceTemplate({
      configuration: { url: "https://api/spec.json" },
      dataImport: "../generated/data.json",
      route: "/reference",
      title: "API",
    });
    expect(out).toContain("ui={data.ui}");
  });

  it("passes the default locale's lang/dir to the reference shell", () => {
    const out = scalarReferenceTemplate({
      configuration: { url: "https://api/spec.json" },
      dataImport: "../generated/data.json",
      route: "/reference",
      title: "API",
    });
    // Mirrors the changelog index: default locale under i18n, English baseline
    // otherwise, so the reference no longer hardcodes lang="en" / dir="ltr".
    expect(out).toContain('const htmlLang = i18n ? i18n.defaultLocale : "en";');
    expect(out).toContain('const dir = localeMeta?.dir ?? "ltr";');
    expect(out).toContain("locale={htmlLang}");
    expect(out).toContain("dir={dir}");
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

  it("serves the raw markdown variants per endpoint kind", () => {
    const md = rawMarkdownEndpointTemplate("md");
    expect(md).toContain("text/markdown");
    // The .md endpoint prefers the downleveled variant, falling back to source.
    expect(md).toContain("entry.md ?? entry.mdx");
    const mdx = rawMarkdownEndpointTemplate("mdx");
    expect(mdx).toContain("entry.mdx");
    expect(mdx).not.toContain("entry.md ??");
  });

  it("renders the OG image endpoint", () => {
    const endpoint = ogEndpointTemplate();
    expect(endpoint).toContain("renderOgImage");
    expect(endpoint).toContain("logo: data.config.og.logo");
    expect(endpoint).toContain("palette: data.config.og.palette");
    // An unannotated `const customRoutes = []` is an implicit any[] under a
    // strict tsconfig, failing `blume check` on the generated file (#91).
    expect(endpoint).toContain(
      "const customRoutes: { slug: string; title: string }[] = []"
    );
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

  it("declares the blume:ask module the header imports", () => {
    expect(envTemplate()).toContain('declare module "blume:ask"');
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
