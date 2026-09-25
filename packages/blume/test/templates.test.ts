import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import {
  gateway,
  inkeep,
  llmgateway,
  openaiCompatible,
  openrouter,
  resolveAskBackend,
} from "../src/ai/ask.ts";
import type { ExampleSpec } from "../src/astro/examples.ts";
import { RUNTIME_MODULE_FILES } from "../src/astro/runtime-modules.ts";
import {
  apiNavigationTemplate,
  apiNotFoundTemplate,
  apiPagesIndexTemplate,
  apiPageTemplate,
  apiSearchTemplate,
  askComponentTemplate,
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  changelogIndexTemplate,
  contentAssetsEndpointTemplate,
  contentConfigTemplate,
  exampleMapTemplate,
  exampleSlug,
  examplesPageTemplate,
  exampleWrapperTemplate,
  mcpEndpointTemplate,
  mcpPageFile,
  mixedbreadSearchEndpointTemplate,
  notFoundJsonTemplate,
  notFoundMarkdownTemplate,
  notFoundPageTemplate,
  featuresTemplate,
  navFragmentTemplate,
  ogEndpointTemplate,
  playgroundProxyTemplate,
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
import { mountBasePath, stripBasePath } from "../src/core/base-path.ts";
import type { BlumeConfig } from "../src/core/config-input.ts";
import { TOC_HIDDEN_KEY } from "../src/core/heading-markers.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ProjectContext } from "../src/core/types.ts";
import { cloudflare, node, vercel } from "../src/deploy/adapters/index.ts";
import { scalar } from "../src/reference/index.ts";
import {
  algolia,
  flexsearch,
  mixedbread,
  orama,
  oramaCloud,
  pagefind,
  typesense,
} from "../src/search/adapters/index.ts";

/** A Rolldown log record, as the generated `onLog` hook receives it. */
interface RolldownLog {
  code?: string;
  message: string;
}

/** The generated config's Rolldown `onLog` hook. */
type OnLog = (
  level: string,
  log: RolldownLog,
  handler: (level: string, log: RolldownLog) => void
) => void;

const config = blumeConfigSchema.parse({});

const ASK_PATH = "/p/.blume/src/generated/Ask.astro";
const EXAMPLES_PATH = "/p/.blume/src/generated/examples.ts";
const EXAMPLES_THEME_PATH = "/p/.blume/src/generated/examples.css";
const SEARCH_CLIENT_PATH = "/p/.blume/src/generated/search-client.ts";
const FEATURES_PATH = "/p/.blume/src/generated/features.ts";
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

// A parsed config whose `ai.assistant` block is always present, so resolveAskBackend
// receives a fully-resolved (schema-defaulted) backend config.
const askConfig = (ask: NonNullable<BlumeConfig["ai"]>["assistant"]) =>
  blumeConfigSchema.parse({ ai: { assistant: ask } }).ai.assistant;

const withProvider = (search: BlumeConfig["search"]) =>
  blumeConfigSchema.parse({ search });

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

  it("reads islands through the generated components map, not a separate island map", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).not.toContain("generated/islands");
    expect(out).not.toContain("islandComponents");
    expect(out).toContain("...userMdx,");
  });

  it("no longer imports the removed Warning component", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).not.toContain("Warning");
  });

  it("drops the language switcher on a monolingual page", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    // The route's flag rides into the page props, and gates the switcher.
    expect(out).toContain("monolingual: route.monolingual,");
    expect(out).toContain("const localeSwitch = i18n && !monolingual");
  });

  it("swaps the switcher's fallback locale in base-less space", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    // The base helpers are the manifest's own, imported rather than re-spelled
    // in the emitted frontmatter.
    expect(out).toContain(
      'import { mountBasePath, stripBasePath } from "blume/core/base-path.ts"'
    );
    expect(out).toContain(
      "href: alt ? alt.path : mountLocalized(logicalRoute, l.code)"
    );
    // Run the generated locale helpers and the fallback composition to pin
    // their behavior. The two slices are the locale prefix helpers and the
    // mount/strip pair that follows the hreflang block.
    const localeStart = out.indexOf("const localePrefix");
    const localeEnd = out.indexOf("// Version resolution");
    const mountStart = out.indexOf("const mountLocalized");
    const mountEnd = out.indexOf("const localeSwitch");
    expect(localeStart).toBeGreaterThan(-1);
    expect(localeEnd).toBeGreaterThan(localeStart);
    expect(mountStart).toBeGreaterThan(localeEnd);
    expect(mountEnd).toBeGreaterThan(mountStart);
    const snippet = new Bun.Transpiler({ loader: "ts" }).transformSync(
      `const targetsFor = (i18n, data, route, locale, mountBasePath, stripBasePath) => {
${out.slice(localeStart, localeEnd)}
${out.slice(mountStart, mountEnd)}
return i18n.locales.map((l) => mountLocalized(logicalRoute, l.code));
};`
    );
    type Targets = (
      i18n: {
        defaultLocale: string;
        hideDefaultLocalePrefix: boolean;
        locales: { code: string }[];
      },
      data: { config: { basePath: string } },
      route: string,
      locale: string,
      mount: typeof mountBasePath,
      strip: typeof stripBasePath
    ) => string[];
    // SAFETY: the generated snippet wrapped above declares `targetsFor` with
    // exactly the parameter list and string[] return asserted by `Targets`.
    // oxlint-disable-next-line no-new-func -- evaluating our own generated output
    const targetsFor = new Function(
      `${snippet}\nreturn targetsFor;`
    )() as Targets;
    const i18n = {
      defaultLocale: "en",
      hideDefaultLocalePrefix: true,
      locales: [{ code: "en" }, { code: "ja" }, { code: "ko" }],
    };
    const under = (basePath: string, route: string, locale: string) =>
      targetsFor(
        i18n,
        { config: { basePath } },
        route,
        locale,
        mountBasePath,
        stripBasePath
      );
    // Regression: `route` carries the base path, locale prefixes do not. A page
    // with no `alternates` used to strip its locale from the based route (no
    // match) and then prepend the target locale, emitting `/ja/docs/ja/x` for a
    // page served at `/docs/ja/x`.
    expect(under("/docs", "/docs/ja/reference", "ja")).toEqual([
      "/docs/reference",
      "/docs/ja/reference",
      "/docs/ko/reference",
    ]);
    // The hidden default locale strips nothing and re-adds nothing.
    expect(under("/docs", "/docs/reference", "en")).toEqual([
      "/docs/reference",
      "/docs/ja/reference",
      "/docs/ko/reference",
    ]);
    // A locale root under the base collapses to the bare mount, not `/docs/`.
    expect(under("/docs", "/docs/ja", "ja")).toEqual([
      "/docs",
      "/docs/ja",
      "/docs/ko",
    ]);
    // A page under a folder named like the base (`docs/reference.md` under
    // `basePath: "/docs"`) keeps its folder segment: the base is re-mounted
    // unconditionally, as the manifest mounts it.
    expect(under("/docs", "/docs/docs/reference", "en")).toEqual([
      "/docs/docs/reference",
      "/docs/ja/docs/reference",
      "/docs/ko/docs/reference",
    ]);
    // Without a base path the composition is the pre-fix behavior.
    expect(under("", "/ja/reference", "ja")).toEqual([
      "/reference",
      "/ja/reference",
      "/ko/reference",
    ]);
  });

  it("filters [!toc] slugs through the heading plugin's frontmatter key", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    // The key is interpolated from the shared constant, so a rename cannot
    // silently break the plugin → template contract; the Array.isArray guard
    // keeps a `frontmatter.extend`-declared value from crashing the render.
    expect(out).toContain(`remarkPluginFrontmatter?.${TOC_HIDDEN_KEY}`);
    expect(out).toContain("Array.isArray(tocHiddenRaw)");
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

  // The assistant trigger is the shared header's, not the page's — see
  // askComponentTemplate. A page that wired up its own would double-render it.
  it("leaves the assistant trigger to the header", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: true });
    expect(out).not.toContain("Assistant");
    expect(out).not.toContain("assistantEnabled");
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
    // The docs page pings loaded frames when its listener registers; the
    // frame must answer, and only to its own parent on the docs origin.
    expect(out).toContain(
      'event.data?.type === "blume:example-height-request"'
    );
    expect(out).toContain("event.source === window.parent");
    expect(out).toContain("event.origin === window.location.origin");
    // The body padding folded into the report is read from the live value,
    // not hardcoded — a root font-size override in the user's examples.css
    // must not skew the report.
    expect(out).toContain("getComputedStyle(document.body)");
    // Pinned to the docs origin — never a wildcard target.
    expect(out).toContain("window.location.origin");
    expect(out).not.toContain('"*"');
  });
});

const changelogOpts = exportOpts;

const componentMapOf = (source: string) =>
  /const components = \{[^}]*\};/u.exec(source)?.[0];

describe("changelogIndexTemplate", () => {
  it("imports layout overrides and passes them to RootLayout", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    // Only the layout slots: no entry body renders, so no MDX component map.
    expect(out).toContain(
      'import { layoutOverrides } from "../generated/components.ts"'
    );
    expect(out).not.toContain("mdxComponents");
    expect(out).toContain("layout={layoutOverrides}");
  });

  it("lists each release as a linked row without rendering its body", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    // The index is title, tag, and date only: a body per release would grow
    // the page past what an agent can read in one context window, and every
    // entry has its own page. So neither the component map nor MDX rendering
    // is wired in.
    expect(out).not.toContain("import { getCollection, render }");
    expect(out).not.toContain("Update.astro");
    expect(componentMapOf(out)).toBeUndefined();
    expect(out).not.toContain("<Content");
    expect(out).toContain('href={item.href ?? "#" + item.id}');
    expect(out).toContain("{item.label}");
    expect(out).toContain("tag: entry.data.changelog?.category ?? null,");
    expect(out).toContain("datetime={item.dateTime}");
    // The layout gets no outline: the bare layout has no TOC to feed.
    expect(out).toContain("headings={[]}");
  });

  it("groups the rows by year in the configured date format's zone", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    expect(out).toContain("last.year === item.year");
    expect(out).toContain("timeZone: dateFormatOptions.timeZone,");
    expect(out).toContain('year: "numeric",');
    // A row drops the year its group already shows: a preset style keeps its
    // month wording, a component format just loses the `year` key.
    expect(out).toContain(
      "const { dateStyle, year: _year, ...dateComponents } = dateFormatOptions;"
    );
    expect(out).toContain('month: dateStyle === "medium" ? "short" : "long",');
    expect(out).toContain("<h2 class=");
    expect(out).toContain("{group.year}");
  });

  it("reads only the docs collection when no staged sources exist", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    expect(out).toContain('...(await getCollection("docs")),');
    expect(out).not.toContain('getCollection("staged")');
  });

  it("folds in the staged collection when staged sources exist", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: true });
    expect(out).toContain('...(await getCollection("docs")),');
    expect(out).toContain('...(await getCollection("staged")),');
  });

  it("leaves the assistant trigger to the header", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    expect(out).not.toContain("Assistant");
    expect(out).not.toContain("assistantEnabled");
  });

  it("renders through the sidebar-less, TOC-less bare layout", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    expect(out).toContain('contentLayout="bare"');
  });

  it("canonicalizes under the deployment base, like the catch-all", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    expect(out).toContain(
      'import { withMountedBase } from "blume/components/islands/base-path.ts"'
    );
    expect(out).toContain('const basedRoute = withMountedBase("/changelog");');
    expect(out).toContain("const canonical = base ? base + basedRoute : null;");
  });

  it("wires the generated OG card, gated on og.enabled", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    expect(out).toContain(
      'const ogPath = data.config.og.enabled ? withMountedBase("/og/changelog.png") : null;'
    );
    expect(out).toContain("ogImage={ogImage}");
    expect(out).toContain("ogGenerated={Boolean(ogImage)}");
    expect(out).not.toContain("ogImage={null}");
  });

  it("leaves the site-title suffix to the layout", () => {
    // Prefixing config.title here doubled the brand in the document title
    // ("Acme Changelog - Acme").
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    expect(out).toContain("const pageTitle = changelogTitle;");
    expect(out).not.toContain('data.config.title + " " + changelogTitle');
  });

  it("links each row to its own generated page, under the deployment base", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    // Route lookup keyed by the collection entry id (matches the manifest);
    // the manifest route is base-less, so the row rebases it like the
    // catch-all's canonical does, and falls back to the row's own anchor.
    // Every locale's route for an entry shares its id (translations and
    // fallback copies alike), so only the default locale's routes fill the
    // map — a map over all of them kept the last locale's permalink — and an
    // entry with no default-locale page (a translated changelog file) is
    // left off the unlocalized index rather than listed twice.
    expect(out).toContain(
      "const defaultLocale = i18n ? i18n.defaultLocale : null;"
    );
    expect(out).toContain(
      "if (defaultLocale === null || route.locale === defaultLocale) {"
    );
    expect(out).toContain("routeByEntry.set(route.entryId, route.path);");
    expect(out).toContain(
      "(defaultLocale === null || routeByEntry.has(entry.id))"
    );
    expect(out).toContain("const route = routeByEntry.get(entry.id);");
    expect(out).toContain("href: route ? withMountedBase(route) : null,");
    expect(out).toContain('href={item.href ?? "#" + item.id}');
  });

  it("suffixes repeated heading slugs so each entry keeps its own anchor", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    const start = out.indexOf("const seenIds");
    const end = out.indexOf("// Consecutive releases from the same year");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Run the generated dedupe pass to pin its behavior.
    // SAFETY: the generated snippet sliced above maps heading items to their
    // deduplicated id strings — the exact signature asserted below.
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
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    // Mirrors the catch-all: default locale under i18n, English baseline
    // otherwise, so /changelog chrome doesn't revert to EN_UI / dir="ltr".
    expect(out).toContain('const htmlLang = i18n ? i18n.defaultLocale : "en";');
    expect(out).toContain('const dir = localeMeta?.dir ?? "ltr";');
    expect(out).toContain("locale={htmlLang}");
    expect(out).toContain("dir={dir}");
    expect(out).toContain("ui={data.ui}");
  });

  it("localizes the changelog heading, page title, and description", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    // The chrome comes from the same translatable `changelog` group as the
    // reveal button, with English fallback for a stale data snapshot.
    expect(out).toContain(
      'const changelogTitle = data.ui.changelog?.title ?? "Changelog";'
    );
    expect(out).toContain(
      'data.ui.changelog?.description ??\n  "Product updates, new features, and fixes from every release.";'
    );
    expect(out).toContain("const pageTitle = changelogTitle;");
    expect(out).toContain("<h1>{changelogTitle}</h1>");
    expect(out).toContain("description: changelogDescription,");
    expect(out).not.toContain("<h1>Changelog</h1>");
    // The island-hooks snapshot reuses the same localized page title.
    const reactOut = changelogIndexTemplate({
      ...changelogOpts,
      needsReact: true,
      staged: false,
    });
    expect(reactOut).toContain(
      'page: { route: "/changelog", title: pageTitle }'
    );
  });

  it("shows the whole history at once, with no major-version reveal", () => {
    const out = changelogIndexTemplate({ ...changelogOpts, staged: false });
    // Rows are small enough that collapsing older majors buys nothing, so the
    // progressive-reveal element and its localized button are gone.
    expect(out).not.toContain("blume-changelog");
    expect(out).not.toContain("majorVersion");
    expect(out).not.toContain("showReleases");
    expect(out).not.toContain("<script>");
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

  it("offers recovery links: every tab, then the sitemap and llms.txt when they exist", () => {
    const out = notFoundPageTemplate();
    // Tabs link to their resolved target (a section without an index page
    // resolves to its first page), falling back to the section path.
    expect(out).toContain(
      "...data.navigation.tabs.map((tab) => ({\n    href: withMountedBase(tab.href ?? tab.path),\n    label: tab.label,\n  }))"
    );
    expect(out).toContain(
      '...(data.config.discovery.sitemap\n    ? [{ href: withMountedBase("/sitemap.xml"), label: nf.sitemap }]\n    : [])'
    );
    expect(out).toContain(
      '...(data.config.discovery.llmsTxt\n    ? [{ href: withMountedBase("/llms.txt"), label: nf.llms }]\n    : [])'
    );
    // Rendered as a labeled nav under its own heading, and skipped entirely
    // when nothing is linkable.
    expect(out).toContain("suggestions.length > 0 && (");
    expect(out).toContain("<nav aria-label={nf.suggestions}");
    expect(out).toContain("{nf.suggestions}\n          </h2>");
    expect(out).toContain("{suggestions.map((link) => (");
    expect(out).toContain("<span>{link.label}</span>");
  });

  it("routes the home link through withMountedBase, like the catch-all", () => {
    const out = notFoundPageTemplate();
    expect(out).toContain(
      'import { withMountedBase } from "blume/components/islands/base-path.ts"'
    );
    expect(out).toContain('href={withMountedBase("/")}');
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

describe("notFoundMarkdownTemplate", () => {
  it("is a prerendered endpoint serving Markdown with a token estimate", () => {
    const out = notFoundMarkdownTemplate();
    expect(out).toContain("export const prerender = true;");
    expect(out).toContain("export function GET()");
    expect(out).toContain('"Content-Type": "text/markdown; charset=utf-8"');
    expect(out).toContain(
      '"x-markdown-tokens": String(Math.ceil(body.length / 4))'
    );
  });

  it("renders the translatable notFound copy as a Markdown document", () => {
    const out = notFoundMarkdownTemplate();
    expect(out).toContain("const nf = data.ui.notFound;");
    expect(out).toContain('"# " + nf.title');
    expect(out).toContain("nf.description");
    expect(out).toContain('"## " + nf.suggestions');
    expect(out).toContain(
      '...links.map((link) => "- [" + link.label + "](" + link.href + ")")'
    );
    expect(out).toContain('].join("\\n");');
  });

  it("offers the same recovery set as the HTML page, home first", () => {
    const out = notFoundMarkdownTemplate();
    expect(out).toContain('{ href: href("/"), label: nf.home }');
    expect(out).toContain(
      "...data.navigation.tabs.map((tab) => ({\n    href: href(tab.href ?? tab.path),\n    label: tab.label,\n  }))"
    );
    expect(out).toContain(
      '...(data.config.discovery.sitemap\n    ? [{ href: href("/sitemap.xml"), label: nf.sitemap }]\n    : [])'
    );
    expect(out).toContain(
      '...(data.config.discovery.llmsTxt\n    ? [{ href: href("/llms.txt"), label: nf.llms }]\n    : [])'
    );
    expect(out).toContain(
      '...(data.config.discovery.api\n    ? [{ href: href("/openapi.json"), label: nf.api }]\n    : [])'
    );
  });

  it("makes internal links absolute when the site is known, leaving external hrefs alone", () => {
    const out = notFoundMarkdownTemplate();
    expect(out).toContain(
      'import { withMountedBase } from "blume/components/islands/base-path.ts"'
    );
    expect(out).toContain(
      'import { absoluteUrl } from "blume/core/site-url.ts"'
    );
    expect(out).toContain("const based = withMountedBase(path);");
    expect(out).toContain(
      'return data.config.site && based.startsWith("/") && !based.startsWith("//")\n    ? absoluteUrl(data.config.site, based)\n    : based;'
    );
  });
});

describe("notFoundJsonTemplate", () => {
  it("is a prerendered endpoint serving RFC 9457 problem details", () => {
    const out = notFoundJsonTemplate();
    expect(out).toContain("export const prerender = true;");
    expect(out).toContain('import { problem } from "blume/ai/api/problem.ts";');
    expect(out).toContain("export function GET()");
    expect(out).toContain(
      '"Content-Type": "application/problem+json; charset=utf-8"'
    );
    expect(out).toContain('code: "PAGE_NOT_FOUND"');
    expect(out).toContain("status: 404");
    expect(out).toContain("title: nf.title");
    expect(out).toContain("detail: nf.description");
  });

  it("carries the Markdown twin's recovery set as links and a resolution", () => {
    const out = notFoundJsonTemplate();
    expect(out).toContain('{ href: href("/"), label: nf.home }');
    expect(out).toContain(
      "...data.navigation.tabs.map((tab) => ({\n    href: href(tab.href ?? tab.path),\n    label: tab.label,\n  }))"
    );
    expect(out).toContain(
      '...(data.config.discovery.sitemap\n    ? [{ href: href("/sitemap.xml"), label: nf.sitemap }]\n    : [])'
    );
    expect(out).toContain(
      '...(data.config.discovery.llmsTxt\n    ? [{ href: href("/llms.txt"), label: nf.llms }]\n    : [])'
    );
    expect(out).toContain(
      '...(data.config.discovery.api\n    ? [{ href: href("/openapi.json"), label: nf.api }]\n    : [])'
    );
    expect(out).toContain("  links,");
    expect(out).toContain(
      'resolution: nf.suggestions + ": " + links.map((link) => link.href).join(", ")'
    );
    expect(out).toContain(
      'return data.config.site && based.startsWith("/") && !based.startsWith("//")\n    ? absoluteUrl(data.config.site, based)\n    : based;'
    );
  });
});

describe("JSON docs API templates", () => {
  it("prerenders the page index, per-page documents, and navigation over the shared snapshot", () => {
    for (const out of [
      apiPagesIndexTemplate(),
      apiPageTemplate(),
      apiNavigationTemplate(),
    ]) {
      expect(out).toContain("export const prerender = true;");
      expect(out).toContain('import data from "blume:mcp-data";');
      expect(out).toContain('from "blume/ai/api/handlers.ts"');
    }
    expect(apiPagesIndexTemplate()).toContain(
      "return pagesIndexResponse(data);"
    );
    expect(apiPageTemplate()).toContain("return pageParams(data);");
    expect(apiPageTemplate()).toContain(
      "return pageResponse(data, props.route);"
    );
    expect(apiNavigationTemplate()).toContain(
      "return navigationResponse(data);"
    );
  });

  it("serves search live from the same snapshot", () => {
    const out = apiSearchTemplate();
    expect(out).toContain("export const prerender = false;");
    expect(out).toContain('import data from "blume:mcp-data";');
    expect(out).toContain("const handler = createSearchHandler(data);");
    expect(out).toContain(
      "export const GET: APIRoute = ({ request }) => handler(request);"
    );
  });

  it("bakes the site context into the API catch-all", () => {
    const out = apiNotFoundTemplate({ base: "/docs", site: "https://x.dev" });
    expect(out).toContain("export const prerender = false;");
    expect(out).toContain(
      'const context = {"base":"/docs","site":"https://x.dev"};'
    );
    expect(out).toContain(
      "export const ALL: APIRoute = ({ request }) => apiNotFoundResponse(request, context);"
    );
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
      ai: {
        assistant: { enabled: true, provider: openrouter({ model: "x/y" }) },
      },
      reference: [
        scalar({
          spec: "https://x.dev/openapi.json",
        }),
      ],
    });
    const deps = runtimeDependencies({ config: full, needsReact: true });
    expect(deps).toContain("@astrojs/react");
    expect(deps).toContain("@scalar/astro");
    expect(deps).toContain("@openrouter/ai-sdk-provider");
  });

  it("adds the server adapter dependency the descriptor declares", () => {
    const server = blumeConfigSchema.parse({ deployment: vercel() });
    expect(
      runtimeDependencies({ config: server, needsReact: false })
    ).toContain("@astrojs/vercel");
    // A static build on a host imports no adapter, so it declares none.
    const onHost = blumeConfigSchema.parse({
      deployment: vercel({ output: "static" }),
    });
    expect(
      runtimeDependencies({ config: onHost, needsReact: false })
    ).not.toContain("@astrojs/vercel");
  });

  it("declares each analytics adapter's runtimeDeps", () => {
    const withAnalytics = blumeConfigSchema.parse({
      analytics: [
        { kind: "vercel", options: {}, requiredSecrets: [], runtimeDeps: [] },
        {
          kind: "script",
          options: { src: "https://x.test/a.js" },
          requiredSecrets: [],
          runtimeDeps: ["probe-analytics-sdk"],
        },
      ],
    });
    expect(
      runtimeDependencies({ config: withAnalytics, needsReact: false })
    ).toContain("probe-analytics-sdk");
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
      'import Assistant from "blume/components/islands/Assistant.astro"'
    );
    expect(out).toContain("<Assistant");
    expect(out).toContain("data.config.assistant?.endpoint ?? undefined");
    expect(out).toContain("data.config.assistant?.suggestions ?? []");
  });

  // The reason this component exists: the header imports it unconditionally, so
  // when Ask is off it must not drag React into a project that has no React
  // renderer wired into its generated Astro config.
  it("imports no island when ask is off, and renders nothing", () => {
    const out = askComponentTemplate(false);
    expect(out).not.toContain("Assistant");
    expect(out).not.toMatch(/^import /mu);
    expect(out.replaceAll(/^---$[\S\s]*?^---$/gmu, "").trim()).toBe("");
  });
});

describe("astroConfigTemplate", () => {
  it("loads configured integrations after every built-in integration", () => {
    const configured = blumeConfigSchema.parse({
      integrations: [
        { hooks: {}, name: "duplicate" },
        { hooks: {}, name: "duplicate" },
      ],
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: configured,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      integrationBridge: {
        configFile: "../blume.config.ts",
        sourceHash: "a".repeat(64),
      },
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });

    expect(out).toContain(
      'import { createModuleLoader } from "blume/core/load-module.ts"'
    );
    expect(out).toContain(
      'resolve(dirname(fileURLToPath(import.meta.url)), "../blume.config.ts")'
    );
    expect(out).toContain(`// Blume config source SHA-256: ${"a".repeat(64)}`);
    const builtIn = out.lastIndexOf("blumeIntegration(");
    const user = out.indexOf("...(blumeConfig?.integrations ?? [])");
    expect(builtIn).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(builtIn);
    expect(
      out.match(/\.\.\.\(blumeConfig\?\.integrations \?\? \[\]\)/gu)
    ).toHaveLength(1);
    expect(out).not.toContain('"duplicate"');
    expect(out).not.toContain("new Set");
  });

  it("emits a static config with fonts and no framework renderers by default", () => {
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('output: "static"');
    // One canonical URL per page; Astro and the adapters enforce it from here.
    expect(out).toContain('trailingSlash: "never"');
    expect(out).toContain("fontProviders.google()");
    expect(out).toContain(
      'import { defineConfig, fontProviders } from "astro/config"'
    );
    expect(out).not.toContain('import react from "@astrojs/react"');
    expect(out).toContain("blumeIntegration(");
    // The hidden runtime gets its content routes and Link header from the CLI
    // in memory, so a route change never rewrites (and restarts on) this file.
    expect(out).not.toContain("contentRoutes");
    expect(out).not.toContain("homeLinkHeader");
    // `blume build` publishes its scanned project for the deploy artifacts;
    // only an ejected app asks the hook to scan.
    expect(out).not.toContain("buildArtifactsRoot");
    // The prerender dep-link plugin is wired into the Vite config so isolated
    // linkers can resolve externalized deps when generating static pages, the
    // include-HMR plugin turns a partial edit into an invalidation of the
    // pages that splice it, and the runtime-modules plugin serves the data
    // snapshots (`blume:data`, the search index, …) from memory.
    expect(out).toContain(
      'import { blumeIntegration, includeHmrPlugin, prerenderDepsPlugin, runtimeModulesPlugin } from "blume/astro"'
    );
    expect(out).toContain("prerenderDepsPlugin()");
    expect(out).toContain("plugins: [runtimeModulesPlugin(), tailwindcss()");
    // In-memory modules need no file aliases — only the file-backed ids keep
    // one.
    expect(out).not.toContain('"blume:data":');
    expect(out).not.toContain('"blume:openapi":');
    expect(out).toContain('"blume:ask": "/p/.blume/src/generated/Ask.astro"');
    expect(out).toContain(
      'includeHmrPlugin("/p/.blume/src/generated/includes.json")'
    );
    // The client router's in-place swaps read from the prefetch cache, so
    // every link prefetches on hover/viewport to hide the request latency
    // behind user intent.
    expect(out).toContain("prefetch: { prefetchAll: true },");
    // Pages prerender concurrently so the main thread renders the next page
    // while a page's OG card renders off-thread; the config computes the
    // count on the machine that builds (an ejected project runs the same
    // file elsewhere).
    expect(out).toContain('import { availableParallelism } from "node:os";');
    expect(out).toContain(
      "build: { concurrency: Math.min(8, availableParallelism()) },"
    );
    // The runtime's node_modules is a junction shared with every Blume project
    // that resolves the same package, so Astro's and Vite's caches (the content
    // data store among them) live inside the runtime dir, never under it.
    expect(out).toContain('cacheDir: "/p/.blume/.cache/astro",');
    expect(out).toContain('cacheDir: "/p/.blume/.cache/vite",');
    // Both lazy client-side deps are pre-bundled through the `blume` package so
    // their CJS/UMD entries get ESM interop in dev; the nested form is required
    // because neither is a direct dep of the generated project, and
    // epub-gen-memory names the `/bundle` subpath it actually imports — the
    // package root would leave that entry unoptimized. Astro's client-router
    // virtual modules must stay OUT of this list: pre-bundling strips the
    // `define`-injected constants they read. See the optimizeDeps comment.
    // The default search adapter's client library rides along (see
    // test/dev-optimize-deps.test.ts).
    expect(out).toContain(
      'include: ["blume > mermaid","blume > epub-gen-memory/bundle","blume > @orama/orama"]'
    );
    // Without a pages dir or aliases, the optimizer scan still covers the
    // convention islands dir so their deps land in the initial optimization.
    expect(out).toContain('entries: ["/p/islands/**/*.{jsx,svelte,tsx,vue}"]');
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
    // load time — ignoring it serves stale `.md` HTML until a restart. Astro's
    // content watcher honors the collection's negated globs, so no layout
    // needs a `server.watch.ignored` escape hatch.
    expect(out).not.toContain(".astro/**");
    expect(out).not.toContain("watch:");
  });

  it("wires the adapter, site, base, redirects, i18n and renderers", () => {
    const serverConfig = blumeConfigSchema.parse({
      deployment: node({ base: "/docs", site: "https://x.com" }),
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
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: true,
      needsSvelte: true,
      needsVue: true,
      pages: [{ entrypoint: "/p/pages/x.astro", pattern: "/x" }],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import adapter from "@astrojs/node"');
    expect(out).toContain('adapter: adapter({"mode":"standalone"})');
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
      String.raw`react({ exclude: [/\/node_modules\/\.vite\//, /\/\.cache\/vite\//] })`
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
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
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
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
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
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: true,
      pages: [],
      reactCompilerPath: compilerPath,
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain(
      `react({ babel: { plugins: [[${JSON.stringify(compilerPath)}, { target: "19" }]] }, ${String.raw`exclude: [/\/node_modules\/\.vite\//, /\/\.cache\/vite\//]`} })`
    );
    // The Babel-injected `react/compiler-runtime` import is invisible to the
    // optimizer's source scan, so it must ride the include list — otherwise its
    // first request triggers a mid-session re-optimization whose new generation
    // duplicates React and tears down every hydrated island (#157).
    expect(out).toContain('"react/compiler-runtime"');
  });

  it("omits the compiler babel plugin when no compiler path is given", () => {
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: true,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import react from "@astrojs/react"');
    expect(out).toContain(
      String.raw`react({ exclude: [/\/node_modules\/\.vite\//, /\/\.cache\/vite\//] })`
    );
    expect(out).not.toContain("babel-plugin-react-compiler");
    // No compiler, no injected runtime import — keep it out of the optimizer.
    expect(out).not.toContain('"react/compiler-runtime"');
  });

  it("prerenders cloudflare adapter builds in Node so build-time node: imports resolve", () => {
    const cloudflareConfig = blumeConfigSchema.parse({
      deployment: cloudflare(),
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: cloudflareConfig,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('import adapter from "@astrojs/cloudflare"');
    expect(out).toContain(
      'adapter: adapter({"imageService":"compile","prerenderEnvironment":"node"})'
    );
  });

  it("opts cloudflare builds out of the adapter's KV session and Images bindings", () => {
    const cloudflareConfig = blumeConfigSchema.parse({
      deployment: cloudflare(),
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: cloudflareConfig,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    // Astro's opt-out keeps the adapter from declaring a SESSION KV binding
    // Blume never reads; no driver import is needed for it.
    expect(out).toContain(
      'import { defineConfig, fontProviders } from "astro/config";'
    );
    expect(out).toContain("session: false,");
    expect(out).toContain('"imageService":"compile"');
  });

  it("leaves sessions alone for non-cloudflare server adapters", () => {
    const nodeConfig = blumeConfigSchema.parse({
      deployment: node(),
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: nodeConfig,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).not.toContain("sessionDrivers");
    expect(out).not.toContain("session:");
  });

  it("points the cloudflare adapter configPath at a project-root wrangler config so the dev workerd runtime picks up nodejs_compat", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-cf-"));
    try {
      await writeFile(
        join(root, "wrangler.toml"),
        'compatibility_flags = ["nodejs_compat"]\n'
      );
      const cloudflareConfig = blumeConfigSchema.parse({
        deployment: cloudflare(),
      });
      const out = astroConfigTemplate({
        askPath: ASK_PATH,
        config: cloudflareConfig,
        contentRoutes: [],
        context: context({
          outDir: join(root, ".blume"),
          root,
        }),
        examplesPath: EXAMPLES_PATH,
        examplesThemePath: EXAMPLES_THEME_PATH,
        featuresPath: FEATURES_PATH,
        needsReact: false,
        pages: [],
        searchClientPath: SEARCH_CLIENT_PATH,
        themePath: THEME_PATH,
      });
      expect(out).toContain(
        'adapter: adapter({"imageService":"compile","prerenderEnvironment":"node","configPath":"../wrangler.toml"})'
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("prefixes ./ when the wrangler config sits beside the generated config", async () => {
    // The theoretical sibling case: `relative()` yields a bare filename, which
    // must be normalized to an explicit `./` so it reads as a relative import.
    const root = await mkdtemp(join(tmpdir(), "blume-cf-sibling-"));
    try {
      await writeFile(
        join(root, "wrangler.toml"),
        'compatibility_flags = ["nodejs_compat"]\n'
      );
      const cloudflareConfig = blumeConfigSchema.parse({
        deployment: cloudflare(),
      });
      const out = astroConfigTemplate({
        askPath: ASK_PATH,
        config: cloudflareConfig,
        contentRoutes: [],
        context: context({
          outDir: root,
          root,
        }),
        examplesPath: EXAMPLES_PATH,
        examplesThemePath: EXAMPLES_THEME_PATH,
        featuresPath: FEATURES_PATH,
        needsReact: false,
        pages: [],
        searchClientPath: SEARCH_CLIENT_PATH,
        themePath: THEME_PATH,
      });
      expect(out).toContain('"configPath":"./wrangler.toml"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("omits adapter options for adapters that need none", () => {
    const vercelConfig = blumeConfigSchema.parse({
      deployment: vercel(),
    });
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: vercelConfig,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
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
        deployment: vercel(),
      }),
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
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
        deployment: vercel(),
      }),
      contentRoutes: [],
      context: context({
        distDir: "/p/.blume-verify/dist",
        outDir: "/p/.blume-verify",
      }),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain(
      'adapter: withAdapterRoot(adapter(), "/p/.blume-verify"),'
    );
  });

  it("hands an ejected app's Vercel adapter no redirected root", () => {
    // After eject the Astro root is the project root, so the adapter already
    // sees the right one — and a baked-in path would break other checkouts.
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: blumeConfigSchema.parse({ deployment: vercel() }),
      contentRoutes: [],
      context: context({ distDir: "./dist", outDir: ".", root: "." }),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      generatedModulesDir: "./src/generated",
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain("adapter: adapter(),");
    expect(out).toContain('outDir: "./dist"');
    expect(out).not.toContain("withAdapterRoot");
  });

  it("points an ejected app's processors at the data snapshot file", () => {
    // With no CLI to publish `blume:data`, relative page links resolve
    // through the snapshot file, found relative to the config itself.
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context({ distDir: "./dist", outDir: ".", root: "." }),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      generatedModulesDir: "./src/generated",
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    const dataFile =
      'dataFile: fileURLToPath(new URL("./src/generated/data.json", import.meta.url)) }';
    expect(out).toContain(`blumeMdxProcessor({ ...{`);
    expect(out.split(dataFile)).toHaveLength(3);
  });

  it("drops only Rolldown's head-inject directive warning from build logs", async () => {
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toMatch(
      /^\/\/ Generated by Blume\. Do not edit; this file is recreated on each run\./u
    );
    // Run the emitted hook as a module: it must forward everything but that
    // one warning to Vite's handler.
    const hook =
      /rolldownOptions: \{\s*(?<body>onLog\(level, log, handler\) \{[\s\S]*?\n {8}\}),/u.exec(
        out
      )?.groups?.body;
    expect(hook).toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "blume-onlog-"));
    try {
      const file = join(dir, "on-log.mjs");
      await writeFile(file, `export default { ${hook} };\n`);
      // SAFETY: the module written above exports the emitted hook object.
      const { default: options } = (await import(file)) as {
        default: { onLog: OnLog };
      };
      const forwarded: RolldownLog[] = [];
      const handler = (_level: string, log: RolldownLog) => {
        forwarded.push(log);
      };
      options.onLog(
        "warn",
        {
          code: "MODULE_LEVEL_DIRECTIVE",
          message:
            'The semantics of the module level directive "use astro:head-inject" in "docs/a.mdx?astroPropagatedAssets" may not be preserved when bundling.',
        },
        handler
      );
      const kept: RolldownLog[] = [
        {
          code: "MODULE_LEVEL_DIRECTIVE",
          message: 'The semantics of the module level directive "use client"…',
        },
        { code: "CIRCULAR_DEPENDENCY", message: "use astro:head-inject" },
      ];
      for (const log of kept) {
        options.onLog("warn", log, handler);
      }
      expect(forwarded).toEqual(kept);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("leaves non-Vercel adapters unwrapped", () => {
    // Only Vercel resolves a dependency trace against `root`; node is standalone
    // and cloudflare emits into `outDir`, so neither needs the override.
    const out = astroConfigTemplate({
      askPath: ASK_PATH,
      config: blumeConfigSchema.parse({
        deployment: node(),
      }),
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    expect(out).toContain('adapter: adapter({"mode":"standalone"}),');
    expect(out).not.toContain("withAdapterRoot");
  });

  it("wires project tsconfig aliases into vite resolve.alias, longest first", () => {
    const out = astroConfigTemplate({
      aliases: { "@": "/proj/src", "@ui": "/proj/src/components/ui" },
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
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

  it("points the optimizer scan at user pages, islands, and alias dirs", () => {
    const out = astroConfigTemplate({
      aliases: { "@": "/proj/src", "@ui": "/proj/src/components/ui" },
      askPath: ASK_PATH,
      config,
      contentRoutes: [],
      context: context({ pagesRoot: "/p/pages" }),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });
    // User sources live outside the Vite root (`.blume/`), so without explicit
    // entries the scanner never crawls them and their deps are only discovered
    // mid-session — the re-optimization that duplicates React (#157). Alias
    // dirs are deduped and sorted so the generated config is deterministic.
    expect(out).toContain(
      'entries: ["/p/pages/**/*.astro","/p/islands/**/*.{jsx,svelte,tsx,vue}","/proj/src/**/*.{astro,jsx,svelte,tsx,vue}","/proj/src/components/ui/**/*.{astro,jsx,svelte,tsx,vue}"]'
    );
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
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
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
    // The include-aware digest wrapper rides the docs loader so `<include>`-
    // bearing .md pages re-render instead of trusting the sync-time cache.
    expect(out).toContain('import { withIncludeRefresh } from "blume/astro";');
    expect(out).toContain("withIncludeRefresh(glob(");
    // The scan's page schema types `entry.data` for the generated pages.
    expect(out).toContain(
      'import { pageCollectionSchema } from "blume/core/schema.ts";'
    );
    expect(out).toContain("schema: pageCollectionSchema,");
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
    // Migrated `.`-rooted project: the filesystem source roots the collection
    // at the project root, so `.blume/` is nested and must be excluded.
    const out = contentConfigTemplate({
      config: blumeConfigSchema.parse({ content: { root: "." } }),
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

/** The backend a schema-parsed `ai.assistant` block resolves to. */
const backendFor = (ask: NonNullable<BlumeConfig["ai"]>["assistant"]) =>
  resolveAskBackend(askConfig(ask)?.provider);

const COMPATIBLE = {
  apiKeyEnv: "GW_KEY",
  baseUrl: "https://api.example.com/v1",
  model: "m",
};

/** One descriptor per adapter, for the assertions every adapter must meet. */
const EVERY_ADAPTER = [
  gateway(),
  openrouter({ model: "x/y" }),
  llmgateway({ model: "m" }),
  inkeep({ model: "m" }),
  openaiCompatible(COMPATIBLE),
];

describe("askEndpointTemplate", () => {
  it("uses the AI gateway (core model id) by default", () => {
    const out = askEndpointTemplate(resolveAskBackend());
    expect(out).toContain(
      'import { createGateway, createTextStreamResponse, streamText, toTextStream } from "ai";'
    );
    expect(out).toContain(
      'const gateway = createGateway({\n  apiKey: getSecret("AI_GATEWAY_API_KEY"),\n});'
    );
    expect(out).toContain('model: gateway("openai/gpt-5.5")');
    expect(out).not.toContain("createOpenRouter");
    expect(out).not.toContain("process.env");
    expect(out).not.toContain("headers:");
    // No `reasoning` or `providerOptions`: the provider keeps its defaults.
    expect(out).not.toContain("reasoning");
    expect(out).not.toContain("providerOptions");
    // No `ai.assistant.cors`: no preflight handler, no wrapper around the POST.
    expect(out).not.toContain("OPTIONS");
    expect(out).not.toContain("blume/ai/cors.ts");
    expect(out).toContain(
      "export const POST: APIRoute = async ({ request }) => {"
    );
    expect(out).toContain("{ status: 400 }");
    expect(out).toContain(
      "return createTextStreamResponse({\n      stream: toTextStream({ stream: result.stream }),\n    });"
    );
  });

  it("answers preflight and wraps the POST when ai.assistant.cors is set", () => {
    const out = askEndpointTemplate(resolveAskBackend(), {
      cors: ["https://www.example.com", "http://localhost:3000"],
    });
    expect(out).toContain(
      'import { preflightResponse, withCors } from "blume/ai/cors.ts";'
    );
    expect(out).toContain(
      'const ALLOWED_ORIGINS = ["https://www.example.com","http://localhost:3000"];'
    );
    // The preflight the island's JSON POST triggers.
    expect(out).toContain(
      "export const OPTIONS: APIRoute = ({ request }) =>\n  preflightResponse(request, ALLOWED_ORIGINS);"
    );
    // The POST is wrapped once, so every response — the stream and the
    // errors — carries the headers without each `return` opting in, and a
    // cross-origin caller can read a 400 or 500 instead of an opaque failure.
    expect(out).toContain(
      "export const POST: APIRoute = withCors(ALLOWED_ORIGINS, async ({ request }) => {"
    );
    expect(out).toContain("  }\n});\n");
    expect(out).toContain("{ status: 400 }");
    expect(out).toContain(
      "return createTextStreamResponse({\n      stream: toTextStream({ stream: result.stream }),\n    });"
    );
  });

  it("wraps the POST of every adapter", () => {
    for (const provider of EVERY_ADAPTER) {
      const out = askEndpointTemplate(backendFor({ enabled: true, provider }), {
        cors: ["https://www.example.com"],
      });
      expect(out).toContain("withCors(ALLOWED_ORIGINS,");
      expect(out).toContain("export const OPTIONS");
    }
  });

  it("imports the provider SDK by bare name and never the config", () => {
    for (const provider of EVERY_ADAPTER) {
      const out = askEndpointTemplate(backendFor({ enabled: true, provider }));
      expect(out).not.toContain("blume.config");
      expect(out).not.toContain("process.env");
      expect(out).toContain('import { getSecret } from "astro:env/server";');
    }
  });

  it("generates the gateway route with reasoning as the call option", () => {
    const out = askEndpointTemplate(
      backendFor({
        enabled: true,
        provider: gateway({
          model: "anthropic/claude-sonnet-4-5",
          reasoning: "none",
        }),
      })
    );
    expect(out).toContain(
      'import { createGateway, createTextStreamResponse, streamText, toTextStream } from "ai";'
    );
    expect(out).toContain(
      'const gateway = createGateway({\n  apiKey: getSecret("AI_GATEWAY_API_KEY"),\n});'
    );
    expect(out).toContain(
      'if (!(getSecret("AI_GATEWAY_API_KEY") || getSecret("VERCEL_OIDC_TOKEN")))'
    );
    // Grounded: the instructions come from `ground`, and the level is the AI
    // SDK's top-level `reasoning`, which the gateway maps to the model's own.
    expect(out).toContain("const ground = createAskContext(askData);");
    expect(out).toContain(
      'model: gateway("anthropic/claude-sonnet-4-5"),\n      instructions,\n      messages,\n      reasoning: "none",\n      onError({ error })'
    );
  });

  it("generates the OpenRouter route with reasoning on the model, not the call", () => {
    const out = askEndpointTemplate(
      backendFor({
        enabled: true,
        provider: openrouter({ model: "x/y", reasoning: "none" }),
      })
    );
    expect(out).toContain(
      'import { createTextStreamResponse, streamText, toTextStream } from "ai";'
    );
    expect(out).toContain(
      'import { createOpenRouter } from "@openrouter/ai-sdk-provider";'
    );
    expect(out).toContain(
      'const openrouter = createOpenRouter({\n  apiKey: getSecret("OPENROUTER_API_KEY"),\n});'
    );
    expect(out).toContain('if (!getSecret("OPENROUTER_API_KEY"))');
    // The OpenRouter provider ignores the AI SDK's top-level `reasoning` call
    // option, so the level rides on the model as `reasoning.effort` — and
    // nowhere else, so the ejected route doesn't carry a dead field.
    expect(out).toContain(
      'model: openrouter("x/y", { reasoning: { effort: "none" } }),\n      instructions,\n      messages,\n      onError({ error })'
    );
    expect(out).not.toContain('reasoning: "none"');
    // Without a level the model takes no settings object.
    expect(
      askEndpointTemplate(
        backendFor({ enabled: true, provider: openrouter({ model: "x/y" }) })
      )
    ).toContain('model: openrouter("x/y"),\n      instructions,');
  });

  it("generates the LLMGateway route through the OpenAI-compatible provider", () => {
    const out = askEndpointTemplate(
      backendFor({
        enabled: true,
        provider: llmgateway({ model: "m", reasoning: "high" }),
      })
    );
    expect(out).toContain(
      'import { createTextStreamResponse, streamText, toTextStream } from "ai";'
    );
    expect(out).toContain(
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";'
    );
    expect(out).toContain(
      'const provider = createOpenAICompatible({\n  apiKey: getSecret("LLMGATEWAY_API_KEY"),\n  baseURL: "https://api.llmgateway.io/v1",\n  name: "llmgateway",\n});'
    );
    expect(out).toContain('if (!getSecret("LLMGATEWAY_API_KEY"))');
    // Grounded, with the level as the call option (sent as `reasoning_effort`).
    expect(out).toContain("const ground = createAskContext(askData);");
    expect(out).toContain(
      'model: provider("m"),\n      instructions,\n      messages,\n      reasoning: "high",\n      onError({ error })'
    );
  });

  it("generates the Inkeep route ungrounded, on the plain prompt, with no reasoning", () => {
    const out = askEndpointTemplate(
      backendFor({
        enabled: true,
        provider: inkeep({ model: "inkeep-qa-expert" }),
      })
    );
    expect(out).toContain(
      'const provider = createOpenAICompatible({\n  apiKey: getSecret("INKEEP_API_KEY"),\n  baseURL: "https://api.inkeep.com/v1",\n  name: "inkeep",\n});'
    );
    expect(out).toContain('if (!getSecret("INKEEP_API_KEY"))');
    // Inkeep retrieves from its own index: no grounding module, no snapshot.
    expect(out).not.toContain("createAskContext");
    expect(out).not.toContain("blume:ask-data");
    expect(out).toContain(
      'model: provider("inkeep-qa-expert"),\n      instructions:\n        "You are a helpful documentation assistant. Answer using the project\'s documentation.",\n      messages,\n      onError({ error })'
    );
    expect(out).not.toContain("reasoning");
  });

  it("generates the OpenAI-compatible route from the configured endpoint", () => {
    const out = askEndpointTemplate(
      backendFor({
        enabled: true,
        provider: openaiCompatible({
          ...COMPATIBLE,
          name: "acme",
          reasoning: "low",
        }),
      })
    );
    expect(out).toContain(
      'const provider = createOpenAICompatible({\n  apiKey: getSecret("GW_KEY"),\n  baseURL: "https://api.example.com/v1",\n  name: "acme",\n});'
    );
    expect(out).toContain('if (!getSecret("GW_KEY"))');
    expect(out).toContain("The assistant is not configured: set GW_KEY.");
    expect(out).toContain("const ground = createAskContext(askData);");
    expect(out).toContain(
      'model: provider("m"),\n      instructions,\n      messages,\n      reasoning: "low",\n      onError({ error })'
    );
  });

  it("forwards providerOptions verbatim to streamText on every adapter", () => {
    const providerOptions = { openai: { textVerbosity: "low" } };
    const expected =
      'providerOptions: {"openai":{"textVerbosity":"low"}},\n      onError({ error })';
    for (const provider of [
      gateway({ providerOptions }),
      openrouter({ model: "x/y", providerOptions, reasoning: "low" }),
      llmgateway({ model: "m", providerOptions }),
      inkeep({ model: "m", providerOptions }),
      openaiCompatible({ ...COMPATIBLE, providerOptions }),
    ]) {
      expect(
        askEndpointTemplate(backendFor({ enabled: true, provider }))
      ).toContain(expected);
    }
    // After the adapter's own call fields.
    expect(
      askEndpointTemplate(
        backendFor({
          enabled: true,
          provider: gateway({ providerOptions, reasoning: "none" }),
        })
      )
    ).toContain(
      'reasoning: "none",\n      providerOptions: {"openai":{"textVerbosity":"low"}},'
    );
  });

  it("inlines headers into every provider factory", () => {
    const headers = { "X-Caller-Id": "docs", "X-Team": "platform" };
    const expected = `  headers: ${JSON.stringify(headers)},`;

    const gw = askEndpointTemplate(
      backendFor({ enabled: true, provider: gateway({ headers }) })
    );
    expect(gw).toContain(
      `createGateway({\n  apiKey: getSecret("AI_GATEWAY_API_KEY"),\n${expected}\n});`
    );

    const router = askEndpointTemplate(
      backendFor({
        enabled: true,
        provider: openrouter({ headers, model: "x/y" }),
      })
    );
    expect(router).toContain(
      `createOpenRouter({\n  apiKey: getSecret("OPENROUTER_API_KEY"),\n${expected}\n});`
    );

    const compatible = askEndpointTemplate(
      backendFor({
        enabled: true,
        provider: openaiCompatible({ ...COMPATIBLE, headers }),
      })
    );
    // Sits between the key and the name so the API key's `Authorization`
    // header is applied first and custom headers can't displace it.
    expect(compatible).toContain(
      `  apiKey: getSecret("GW_KEY"),\n  baseURL: "https://api.example.com/v1",\n${expected}\n  name: "openai-compatible",`
    );
  });

  it("leaves headers out of the factories when the map is empty", () => {
    const out = askEndpointTemplate(
      backendFor({
        enabled: true,
        provider: openrouter({ headers: {}, model: "x/y" }),
      })
    );
    expect(out).toContain(
      'createOpenRouter({\n  apiKey: getSecret("OPENROUTER_API_KEY"),\n});'
    );
    expect(out).not.toContain("headers:");
  });

  it("threads custom instructions into the grounded route and its fallback", () => {
    const out = askEndpointTemplate(resolveAskBackend(), {
      instructions: "Answer in French.",
    });
    expect(out).toContain(
      'createAskContext(askData, { instructions: "Answer in French." })'
    );
    expect(out).toContain(
      "Answer using the project's documentation.\\n\\nAnswer in French."
    );
  });

  it("threads the configured retrieval sizes into the grounded route", () => {
    const out = askEndpointTemplate(resolveAskBackend(), {
      retrieval: { contextBudget: 2500, excerptChars: 1200, maxResults: 3 },
    });
    expect(out).toContain(
      'createAskContext(askData, { retrieval: {"contextBudget":2500,"excerptChars":1200,"maxResults":3} })'
    );
  });

  it("carries instructions and retrieval together", () => {
    const out = askEndpointTemplate(resolveAskBackend(), {
      instructions: "Answer in French.",
      retrieval: { contextBudget: 2500 },
    });
    expect(out).toContain('instructions: "Answer in French."');
    expect(out).toContain('retrieval: {"contextBudget":2500}');
  });

  it("appends custom instructions to the ungrounded prompt", () => {
    const out = askEndpointTemplate(
      backendFor({ enabled: true, provider: inkeep({ model: "m" }) }),
      { instructions: "Answer in French." }
    );
    expect(out).not.toContain("createAskContext");
    expect(out).toContain(
      "Answer using the project's documentation.\\n\\nAnswer in French."
    );
  });

  it("keeps the plain prompt when no instructions are configured", () => {
    const out = askEndpointTemplate(resolveAskBackend());
    expect(out).toContain("createAskContext(askData);");
    expect(out).toContain("Answer using the project's documentation.\"");
  });
});

describe("searchClientTemplate", () => {
  it("loads a static index for orama", () => {
    expect(searchClientTemplate(withProvider(orama()))).toContain(
      "search/orama.ts"
    );
  });

  it("loads a static index for flexsearch", () => {
    expect(searchClientTemplate(withProvider(flexsearch()))).toContain(
      "search/flexsearch.ts"
    );
  });

  it("passes algolia credentials to the hosted client", () => {
    const out = searchClientTemplate(
      withProvider(algolia({ apiKey: "K", appId: "A", indexName: "I" }))
    );
    expect(out).toContain("search/algolia.ts");
    expect(out).toContain('"appId":"A"');
  });

  it("passes orama-cloud credentials to the hosted client", () => {
    const out = searchClientTemplate(
      withProvider(oramaCloud({ apiKey: "K", endpoint: "https://e" }))
    );
    expect(out).toContain("search/orama-cloud.ts");
    expect(out).toContain('"endpoint":"https://e"');
  });

  it("passes typesense credentials to the hosted client", () => {
    const out = searchClientTemplate(
      withProvider(typesense({ apiKey: "K", collection: "c", host: "h" }))
    );
    expect(out).toContain("search/typesense.ts");
  });

  it("points mixedbread at the server endpoint", () => {
    const out = searchClientTemplate(
      withProvider(mixedbread({ storeId: "s" }))
    );
    expect(out).toContain("search/endpoint.ts");
    expect(out).toContain("api/search");
  });

  it("loads pagefind from the build output", () => {
    const out = searchClientTemplate(withProvider(pagefind()));
    expect(out).toContain("search/pagefind.ts");
    expect(out).toContain("pagefind/pagefind.js");
  });

  it("emits a no-op client when search is disabled", () => {
    const out = searchClientTemplate(withProvider(false));
    expect(out).toContain("hits: [], sections: []");
  });
});

describe("scalarReferenceTemplate", () => {
  it("mounts a Scalar reference inside the Blume layout", () => {
    const out = scalarReferenceTemplate({
      configuration: { url: "https://api/spec.json" },
      route: "/reference",
      title: "API",
    });
    expect(out).toContain("ScalarComponent");
    // The page data comes from the in-memory runtime module, whatever depth
    // the reference route sits at.
    expect(out).toContain('import data from "blume:data"');
    expect(out).toContain('route={"/reference"}');
    expect(out).toContain('"url": "https://api/spec.json"');
    expect(out).toContain("noindex={false}");
  });

  it("passes crawler exclusion to the reference layout", () => {
    const out = scalarReferenceTemplate({
      configuration: { url: "https://api/spec.json" },
      noindex: true,
      route: "/reference",
      title: "API",
    });
    expect(out).toContain("noindex={true}");
  });

  it("forwards the localized UI dictionary to the layout", () => {
    const out = scalarReferenceTemplate({
      configuration: { url: "https://api/spec.json" },
      route: "/reference",
      title: "API",
    });
    expect(out).toContain("ui={data.ui}");
  });

  it("passes the default locale's lang/dir to the reference shell", () => {
    const out = scalarReferenceTemplate({
      configuration: { url: "https://api/spec.json" },
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

  it("imports the data snapshot from the runtime module", () => {
    // The module is declared as `McpData` in the injected types, so no cast is needed
    // at the boundary — the id is the same at any route depth.
    const out = mcpEndpointTemplate();
    expect(out).toContain('import data from "blume:mcp-data"');
    expect(out).toContain("createMcpFetchHandler(data)");
    expect(out).not.toContain("generated/");
  });

  it("serializes a fixed payload for the discovery endpoint", () => {
    const out = staticJsonEndpointTemplate({ ok: true });
    expect(out).toContain("export const prerender = true;");
    expect(out).toContain('"ok": true');
  });
});

describe("playgroundProxyTemplate", () => {
  it("wraps the shipped proxy handler in a server-rendered ALL endpoint", () => {
    const out = playgroundProxyTemplate(["https://api.example"]);
    expect(out).toContain("export const prerender = false;");
    expect(out).toContain(
      'import { createPlaygroundProxyHandler } from "blume/openapi/proxy.ts"'
    );
    expect(out).toContain(
      "export const ALL: APIRoute = ({ request }) => handler(request);"
    );
  });

  it("bakes the documented origins in as the handler's allowlist", () => {
    // The trust boundary: the target arrives as a query parameter, so the
    // allowlist must be part of the generated source, not request data.
    expect(playgroundProxyTemplate(["https://api.example"])).toContain(
      'createPlaygroundProxyHandler(["https://api.example"])'
    );
    expect(playgroundProxyTemplate([])).toContain(
      "createPlaygroundProxyHandler([])"
    );
  });
});

describe("static endpoint templates", () => {
  it("serves the static search index", () => {
    expect(searchEndpointTemplate()).toContain(
      'import documents from "blume:search-index"'
    );
  });

  it("proxies mixedbread queries with the store id and every other option", () => {
    const out = mixedbreadSearchEndpointTemplate({
      search_options: { rerank: true },
      storeId: "store_42",
      top_k: 3,
    });
    expect(out).toContain(
      'const OPTIONS = {"search_options":{"rerank":true},"storeId":"store_42","top_k":3}'
    );
    // Every option but the store reaches the search call: `top_k` only
    // defaults to 8, while the query and store stay the request's and
    // `storeId`'s.
    expect(out).toContain(
      "const { storeId: STORE_ID, ...SEARCH_OPTIONS } = OPTIONS;"
    );
    expect(out).toContain(
      "client.stores.search({\n    top_k: 8,\n    ...SEARCH_OPTIONS,\n    query,\n    store_identifiers: [STORE_ID],\n  })"
    );
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

  it("renders one prerendered partial per collapsible or drill-in group", () => {
    const page = navFragmentTemplate();
    expect(page.startsWith("---\n// Generated by Blume.")).toBe(true);
    expect(page).toContain("export const partial = true;");
    expect(page).toContain("export const prerender = true;");
    // `navGroupIds` keys the map by `NavNode`, so the filter narrows to a
    // group before reading `display` (a page node has none: strict TS rejects
    // the bare read under `blume check`).
    expect(page).toContain(
      '([node]) => node.kind === "group" && (node.display ?? "flat") !== "flat"'
    );
    expect(page).toContain("navGroupIds(navigation.sidebar)");
    expect(page).toContain('currentRoute=""');
    expect(page).toContain("fragmentBase={fragmentBase}");
    // Astro hoists getStaticPaths, so the variant walk comes from an import.
    expect(page).toContain(
      "navVariants(data, hiddenDefaultLocale(data.config.i18n)).flatMap("
    );
  });

  it("hands the catch-all page a fragment base only when sections are deferred", () => {
    const withFragments = catchAllPageTemplate({
      ...exportOpts,
      mathEnabled: false,
      navFragments: true,
    });
    expect(withFragments).toContain(
      `navFragmentBase={withMountedBase(\`/blume-nav/\${version || "current"}/\${i18n && localePrefix(locale) ? locale : "default"}\`)}`
    );
    expect(
      catchAllPageTemplate({ ...exportOpts, mathEnabled: false })
    ).not.toContain("navFragmentBase");
  });

  it("emits a loader per client feature, or null when the site lacks it", () => {
    const all = featuresTemplate({ epub: true, mermaid: true });
    expect(all).toContain(
      'export const loadMermaid: (() => Promise<unknown>) | null = () => import("blume/components/content/mermaid-element.ts");'
    );
    expect(all).toContain('| null = () => import("epub-gen-memory/bundle");');
    const none = featuresTemplate({ epub: false, mermaid: false });
    // A null loader leaves the library out of the module graph: no chunk in
    // the client bundle, nothing for the dev optimizer to pre-bundle.
    expect(none).toContain(
      "export const loadMermaid: (() => Promise<unknown>) | null = null;"
    );
    expect(none).toContain("| null = null;");
    // Only the type annotation mentions the EPUB module now; no loader
    // expression imports anything.
    expect(none).not.toContain("() => import(");
  });

  it("renders the OG image endpoint", () => {
    const endpoint = ogEndpointTemplate();
    expect(endpoint).toContain("cachedOgImage(cache, {");
    // No cache given: every card renders (the runtime-dir fallback is the
    // generator's call, not the template's).
    expect(endpoint).toContain("const cache: OgCache | undefined = undefined;");
    expect(endpoint).toContain("logo: data.config.og.logo");
    expect(endpoint).toContain("palette: data.config.og.palette");
    // The footer site text is resolved at generate time (host + deployment
    // base) — deriving it here from `data.config.site` dropped the base (#139).
    expect(endpoint).toContain("site: data.config.og.site");
    expect(endpoint).not.toContain("siteHost");
    // The subtitle is the page's own description, falling back to the
    // resolved og value (which honors the seo.og.description override), not
    // the raw site description.
    expect(endpoint).toContain(
      "description: props.description ?? data.config.og.description"
    );
    expect(endpoint).toContain("route.description");
    // Custom pages have no known description at generate time.
    expect(endpoint).toContain("add(route.slug, route.title, null)");
    // Page descriptions are on unless seo.og.description is false.
    expect(endpoint).toContain("const pageDescriptions = true;");
    // An unannotated `const customRoutes = []` is an implicit any[] under a
    // strict tsconfig, failing `blume check` on the generated file (#91).
    expect(endpoint).toContain(
      "const customRoutes: { slug: string; title: string }[] = []"
    );
    // Fonts are baked in (never read from blume:data — local entries carry
    // absolute build-machine paths and data.config ships to the client).
    expect(endpoint).toContain("const fonts: OgFont[] = []");
    expect(endpoint).toContain(
      "const families: OgFontFamilies | undefined = undefined"
    );
    expect(endpoint).not.toContain("data.config.og.fonts");
  });

  it("bakes the card cache location and version into the endpoint", () => {
    // The directory is a build-machine path, so it rides the build-only
    // endpoint (like local font paths) rather than the runtime data.
    const endpoint = ogEndpointTemplate([], {
      cache: { dir: "/p/node_modules/.cache/blume/og", version: "1.2.3" },
    });
    expect(endpoint).toContain(
      'const cache: OgCache | undefined = {"dir":"/p/node_modules/.cache/blume/og","version":"1.2.3"};'
    );
    expect(endpoint).toContain(
      'import type { OgCache, OgFont, OgFontFamilies } from "blume/og";'
    );
  });

  it("hides page descriptions when seo.og.description is false", () => {
    const endpoint = ogEndpointTemplate([], { pageDescriptions: false });
    expect(endpoint).toContain("const pageDescriptions = false;");
    // The gate is applied when paths are collected, so GET stays uniform.
    expect(endpoint).toContain(
      "props: { title, description: pageDescriptions ? description : null }"
    );
    expect(ogEndpointTemplate([], { pageDescriptions: true })).toContain(
      "const pageDescriptions = true;"
    );
  });

  it("adds the changelog index card only when the index is generated", () => {
    const withIndex = ogEndpointTemplate([], {}, true);
    expect(withIndex).toContain(
      'add(\n    "changelog",\n    data.ui.changelog?.title ?? "Changelog",\n    data.ui.changelog?.description ?? null\n  );'
    );
    // Without the generated index there is no /changelog page to card.
    expect(ogEndpointTemplate()).not.toContain('add("changelog"');
    expect(ogEndpointTemplate([], {}, false)).not.toContain('add("changelog"');
  });

  it("bakes resolved fonts and role families into the OG endpoint", () => {
    const endpoint = ogEndpointTemplate([], {
      families: { body: "Inter", title: "Inter Tight" },
      fonts: [
        { name: "Inter Tight", weight: [400, 600] },
        { name: "Custom", src: "/abs/fonts/custom.woff2" },
      ],
    });
    expect(endpoint).toContain(
      'const fonts: OgFont[] = [{"name":"Inter Tight","weight":[400,600]},{"name":"Custom","src":"/abs/fonts/custom.woff2"}]'
    );
    expect(endpoint).toContain(
      'const families: OgFontFamilies | undefined = {"body":"Inter","title":"Inter Tight"}'
    );
    expect(endpoint).toContain("families,");
    expect(endpoint).toContain("fonts,");
  });

  it("serves one RSS feed per section", () => {
    expect(rssEndpointTemplate()).toContain("application/rss+xml");
  });
});

describe("package / tsconfig templates", () => {
  it("aliases the runtime data modules to files for an ejected project", () => {
    // Eject has no CLI to publish the modules in memory, so every id points
    // at the JSON snapshot eject writes, and the in-memory plugin stays out.
    const out = astroConfigTemplate({
      askPath: "./src/generated/Ask.astro",
      config,
      contentRoutes: ["/guide"],
      context: context(),
      examplesPath: "./src/generated/examples.ts",
      examplesThemePath: "./src/generated/examples.css",
      featuresPath: "./src/generated/features.ts",
      generatedModulesDir: "./src/generated",
      needsReact: false,
      pages: [],
      searchClientPath: "./src/generated/search-client.ts",
      themePath: "./src/generated/app.css",
    });
    // Each alias resolves against the config file when it loads: portable,
    // and the absolute target Vite expects (it warns on a relative one).
    expect(out).toContain('import { fileURLToPath } from "node:url";');
    for (const [id, file] of RUNTIME_MODULE_FILES) {
      expect(out).toContain(
        `${JSON.stringify(id)}: fileURLToPath(new URL(${JSON.stringify(`./src/generated/${file}`)}, import.meta.url))`
      );
    }
    expect(out).toContain(
      '"blume:theme": fileURLToPath(new URL("./src/generated/app.css", import.meta.url))'
    );
    expect(out).not.toContain("runtimeModulesPlugin");
    // The ejected config belongs to the project: no "recreated on each run".
    expect(out).toMatch(/^\/\/ Written by `blume eject`\./u);
    expect(out).not.toContain("Do not edit");
    // Real node_modules after eject: Astro and Vite keep their default caches.
    expect(out).not.toContain("cacheDir:");
    // No CLI publishes the negotiation inputs after eject, so they are baked
    // into the integration call.
    expect(out).toContain('"contentRoutes":["/guide"]');
    // Plain `astro build` scans the project root for the deploy artifacts.
    expect(out).toContain('"buildArtifactsRoot":"."');
    expect(out).toContain(
      'import { blumeIntegration, includeHmrPlugin, prerenderDepsPlugin } from "blume/astro"'
    );
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

describe("astroConfigTemplate image config", () => {
  const render = (parsed: typeof config) =>
    astroConfigTemplate({
      askPath: ASK_PATH,
      config: parsed,
      contentRoutes: [],
      context: context(),
      examplesPath: EXAMPLES_PATH,
      examplesThemePath: EXAMPLES_THEME_PATH,
      featuresPath: FEATURES_PATH,
      needsReact: false,
      pages: [],
      searchClientPath: SEARCH_CLIENT_PATH,
      themePath: THEME_PATH,
    });

  it("emits no image block by default", () => {
    expect(render(config)).not.toContain("image:");
  });

  it("passes authorized domains and remote patterns through to Astro", () => {
    const configured = blumeConfigSchema.parse({
      image: {
        domains: ["cdn.example.com"],
        remotePatterns: [{ hostname: "**.example.com", protocol: "https" }],
      },
    });
    const out = render(configured);
    expect(out).toContain('"domains":["cdn.example.com"]');
    expect(out).toContain('"hostname":"**.example.com"');
    expect(out).toContain('"protocol":"https"');
  });
});

describe("contentAssetsEndpointTemplate", () => {
  const out = contentAssetsEndpointTemplate("/p/.blume/public/blume-assets");

  it("prerenders and reads the generated content-asset map", () => {
    expect(out).toContain("export const prerender = true;");
    expect(out).toContain('import assets from "blume:content-assets"');
  });

  it("bakes in the staged remote-assets directory", () => {
    expect(out).toContain(
      'const STAGED_DIR = "/p/.blume/public/blume-assets";'
    );
  });

  it("guards staged lookups against path traversal", () => {
    // The separator-safe spelling: a prefix test against the forward-slash
    // STAGED_DIR broke on Windows, where resolve() answers with backslashes.
    expect(out).toContain("const rel = relative(STAGED_DIR, abs);");
    expect(out).toContain('rel === "" || rel.startsWith("..") || isAbsolute');
  });
});
