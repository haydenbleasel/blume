import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { discoverContent } from "../src/core/content.ts";
import { buildContentGraph } from "../src/core/graph.ts";
import { EN_UI, resolveUIStrings } from "../src/core/i18n-ui.ts";
import {
  detectLocale,
  i18nDiagnostics,
  i18nEnabled,
  localeCodes,
  localeDir,
  localePlacement,
  localePrefix,
  localizeRoute,
  resolveFallbackLocale,
} from "../src/core/i18n.ts";
import { buildManifest } from "../src/core/manifest.ts";
import { discoverFolderMeta } from "../src/core/meta.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type {
  FolderMeta,
  ResolvedConfig,
  ResolvedI18nConfig,
} from "../src/core/schema.ts";
import type { NavNode, ProjectContext } from "../src/core/types.ts";
import { UI_PACKS } from "../src/core/ui-packs/index.ts";

const config = (i18nOver: Record<string, unknown> = {}): ResolvedConfig =>
  blumeConfigSchema.parse({
    i18n: {
      defaultLocale: "en",
      locales: [
        { code: "en", label: "English" },
        { code: "fr", label: "Français" },
      ],
      ...i18nOver,
    },
  });

const i18nOf = (over: Record<string, unknown> = {}): ResolvedI18nConfig => {
  const value = config(over).i18n;
  if (!value) {
    throw new Error("expected i18n");
  }
  return value;
};

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const FILES: Record<string, string> = {
  "docs/fr/guides/quickstart.mdx": "---\ntitle: Démarrage\n---\n# Démarrage\n",
  "docs/fr/index.mdx": "---\ntitle: Accueil\n---\n# Accueil\n",
  "docs/guides/only-en.mdx": "---\ntitle: Only EN\n---\n# Only EN\n",
  "docs/guides/quickstart.mdx": "---\ntitle: Quickstart\n---\n# Quickstart\n",
  "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
};

const buildProject = async (resolved: ResolvedConfig) => {
  const root = await mkdtemp(join(tmpdir(), "blume-i18n-"));
  dirs.push(root);
  const contentRoot = join(root, "docs");
  await Promise.all(
    Object.entries(FILES).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );

  const { pages } = await discoverContent({
    contentRoot,
    defaultType: resolved.content.defaultType,
    exclude: resolved.content.exclude,
    i18n: resolved.i18n,
    include: resolved.content.include,
  });
  const graph = buildContentGraph(pages, {
    folderMeta: new Map<string, FolderMeta>(),
    i18n: resolved.i18n,
    navigation: resolved.navigation,
  });
  const context = { contentRoot, root } as ProjectContext;
  const manifest = buildManifest({ config: resolved, context, graph });
  return { graph, manifest, pages };
};

const labelsOf = (nodes: NavNode[]): string[] =>
  nodes.map((node) => node.label);

/** Write a content tree to a fresh temp dir and return its content root. */
const tempContent = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-i18n-"));
  dirs.push(root);
  const contentRoot = join(root, "docs");
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(contentRoot, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return contentRoot;
};

const discoverIn = (contentRoot: string, resolved: ResolvedConfig) =>
  discoverContent({
    contentRoot,
    defaultType: resolved.content.defaultType,
    exclude: resolved.content.exclude,
    i18n: resolved.i18n,
    include: resolved.content.include,
  });

describe("i18n helpers", () => {
  it("detects a leading non-default locale dir and strips it", () => {
    const i18n = i18nOf();
    expect(detectLocale(["fr", "guides", "x.mdx"], i18n)).toEqual({
      locale: "fr",
      rest: ["guides", "x.mdx"],
    });
    expect(detectLocale(["guides", "x.mdx"], i18n)).toEqual({
      locale: "en",
      rest: ["guides", "x.mdx"],
    });
  });

  it("detects a locale dir case-insensitively, keeping the configured casing", () => {
    // BCP 47 codes are case-insensitive: the conventional lowercase folder
    // `pt-br/` must resolve to a configured `pt-BR`, with the configured
    // casing flowing into the locale (and thus routes and labels).
    const i18n = i18nOf({
      locales: [
        { code: "en", label: "English" },
        { code: "pt-BR", label: "Português" },
      ],
    });
    expect(detectLocale(["pt-br", "x.mdx"], i18n)).toEqual({
      locale: "pt-BR",
      rest: ["x.mdx"],
    });
    expect(detectLocale(["PT-br", "x.mdx"], i18n)).toEqual({
      locale: "pt-BR",
      rest: ["x.mdx"],
    });
    expect(detectLocale(["pt-pt", "x.mdx"], i18n)).toEqual({
      locale: "en",
      rest: ["pt-pt", "x.mdx"],
    });
  });

  it("hides the default-locale prefix unless opted out", () => {
    expect(localePrefix("en", i18nOf())).toBe("");
    expect(localePrefix("fr", i18nOf())).toBe("/fr");
    expect(localePrefix("en", i18nOf({ hideDefaultLocalePrefix: false }))).toBe(
      "/en"
    );
  });

  it("localizes routes, mapping the home route correctly", () => {
    const i18n = i18nOf();
    expect(localizeRoute("/guides/x", "fr", i18n)).toBe("/fr/guides/x");
    expect(localizeRoute("/", "fr", i18n)).toBe("/fr");
    expect(localizeRoute("/guides/x", "en", i18n)).toBe("/guides/x");
  });

  it("resolves the fallback locale (default, explicit, disabled)", () => {
    expect(resolveFallbackLocale(i18nOf())).toBe("en");
    expect(resolveFallbackLocale(i18nOf({ fallbackLocale: "fr" }))).toBe("fr");
    expect(resolveFallbackLocale(i18nOf({ fallbackLocale: null }))).toBeNull();
  });

  it("reports whether i18n is enabled", () => {
    expect(i18nEnabled(config())).toBe(true);
    expect(i18nEnabled(blumeConfigSchema.parse({}))).toBe(false);
  });

  it("lists configured locale codes, default first", () => {
    expect(localeCodes(i18nOf())).toStrictEqual(["en", "fr"]);
  });

  it("resolves a locale's text direction, defaulting to ltr", () => {
    const i18n = i18nOf({
      defaultLocale: "en",
      locales: [
        { code: "en", label: "English" },
        { code: "ar", dir: "rtl", label: "العربية" },
      ],
    });
    expect(localeDir("ar", i18n)).toBe("rtl");
    expect(localeDir("en", i18n)).toBe("ltr");
    // An unknown code falls back to ltr.
    expect(localeDir("zz", i18n)).toBe("ltr");
  });
});

describe("i18n content discovery", () => {
  it("records locale, prefixed route, translationKey and navPath", async () => {
    const { pages } = await buildProject(config());
    const byId = new Map(pages.map((page) => [page.source.ref, page]));

    const en = byId.get("guides/quickstart.mdx");
    expect(en?.locale).toBe("en");
    expect(en?.route).toBe("/guides/quickstart");
    expect(en?.translationKey).toBe("/guides/quickstart");
    expect(en?.navPath).toBe("guides/quickstart.mdx");

    const fr = byId.get("fr/guides/quickstart.mdx");
    expect(fr?.locale).toBe("fr");
    expect(fr?.route).toBe("/fr/guides/quickstart");
    expect(fr?.translationKey).toBe("/guides/quickstart");
    expect(fr?.navPath).toBe("guides/quickstart.mdx");

    const frHome = byId.get("fr/index.mdx");
    expect(frHome?.route).toBe("/fr");
    expect(frHome?.translationKey).toBe("/");
  });
});

describe("case-insensitive locale folders", () => {
  const ptLocales = [
    { code: "en", label: "English" },
    { code: "pt-BR", label: "Português" },
  ];

  it("routes a lowercase folder for a mixed-case configured locale", async () => {
    // A configured `pt-BR` with the conventional lowercase `pt-br/` folder
    // used to fall through as default-locale content at a literal /pt-br/…
    // route — while the unconfigured-locale diagnostic (which compares
    // case-insensitively) stayed silent.
    const resolved = config({ locales: ptLocales });
    const contentRoot = await tempContent({
      "guides/quickstart.mdx": "# Quickstart\n",
      "pt-br/guides/quickstart.mdx": "# Início\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);
    const byId = new Map(pages.map((page) => [page.source.ref, page]));

    const pt = byId.get("pt-br/guides/quickstart.mdx");
    expect(pt?.locale).toBe("pt-BR");
    expect(pt?.route).toBe("/pt-BR/guides/quickstart");
    expect(pt?.translationKey).toBe("/guides/quickstart");
    expect(pt?.navPath).toBe("guides/quickstart.mdx");

    // The folder now routes as configured content, and the diagnostic agrees.
    expect(i18nDiagnostics(pages, i18nOf({ locales: ptLocales }))).toEqual([]);
  });
});

describe("per-locale navigation", () => {
  it("builds a tree per locale without surfacing the locale dir as a group", async () => {
    const { graph } = await buildProject(config());
    expect(Object.keys(graph.navigationByLocale).toSorted()).toEqual([
      "en",
      "fr",
    ]);

    const fr = graph.navigationByLocale.fr?.sidebar ?? [];
    // The locale dir ("fr") must not appear as a top-level nav group.
    expect(labelsOf(fr)).not.toContain("Fr");
    expect(labelsOf(fr)).toContain("Guides");
  });

  it("fills a locale's sidebar with fallback pages for untranslated content", async () => {
    const { graph } = await buildProject(config());
    const guides = (graph.navigationByLocale.fr?.sidebar ?? []).find(
      (node) => node.kind === "group" && node.label === "Guides"
    );
    const routes =
      guides?.kind === "group"
        ? guides.children
            .filter((child) => child.kind === "page")
            .map((child) => (child.kind === "page" ? child.route : ""))
        : [];
    // The translated quickstart and the untranslated (fallback) only-en page
    // both appear, each at its /fr route.
    expect(routes.toSorted()).toEqual([
      "/fr/guides/only-en",
      "/fr/guides/quickstart",
    ]);
  });

  it("localizes header tab paths per locale", async () => {
    const resolved = blumeConfigSchema.parse({
      i18n: {
        defaultLocale: "en",
        locales: [
          { code: "en", label: "English" },
          { code: "fr", label: "Français" },
        ],
      },
      navigation: {
        tabs: [
          { label: "Docs", path: "/docs" },
          { label: "Home", path: "/" },
        ],
      },
    });
    const { graph } = await buildProject(resolved);

    expect(
      (graph.navigationByLocale.fr?.tabs ?? []).map((tab) => tab.path)
    ).toEqual(["/fr/docs", "/fr"]);
    // The hidden default locale keeps unprefixed tab paths.
    expect(
      (graph.navigationByLocale.en?.tabs ?? []).map((tab) => tab.path)
    ).toEqual(["/docs", "/"]);
  });

  it("localizes tab dropdown item paths per locale", async () => {
    const resolved = blumeConfigSchema.parse({
      i18n: {
        defaultLocale: "en",
        locales: [
          { code: "en", label: "English" },
          { code: "fr", label: "Français" },
        ],
      },
      navigation: {
        tabs: [
          {
            items: [
              { label: "Guides", path: "/docs/guides" },
              { label: "GitHub", path: "https://github.com/acme" },
            ],
            label: "Docs",
            path: "/docs",
          },
        ],
      },
    });
    const { graph } = await buildProject(resolved);

    const itemPaths = (locale: string): string[] =>
      (graph.navigationByLocale[locale]?.tabs ?? []).flatMap((tab) =>
        (tab.items ?? []).map((item) => item.path)
      );
    // Internal dropdown items follow the tab into the locale; external ones
    // pass through untouched.
    expect(itemPaths("fr")).toEqual([
      "/fr/docs/guides",
      "https://github.com/acme",
    ]);
    expect(itemPaths("en")).toEqual([
      "/docs/guides",
      "https://github.com/acme",
    ]);
  });
});

describe("i18n diagnostics", () => {
  it("warns about a locale-looking folder that isn't configured", async () => {
    // Project locales are en + fr; the `de/` folder below is not configured.
    const resolved = config();
    const root = await mkdtemp(join(tmpdir(), "blume-i18n-diag-"));
    dirs.push(root);
    const contentRoot = join(root, "docs");
    await mkdir(join(contentRoot, "de"), { recursive: true });
    await writeFile(join(contentRoot, "index.mdx"), "# Home\n");
    await writeFile(join(contentRoot, "de", "page.mdx"), "# DE\n");

    const { pages } = await discoverContent({
      contentRoot,
      defaultType: resolved.content.defaultType,
      exclude: resolved.content.exclude,
      i18n: resolved.i18n,
      include: resolved.content.include,
    });
    const diagnostics = i18nDiagnostics(pages, i18nOf());
    expect(diagnostics.map((d) => d.code)).toContain(
      "BLUME_I18N_UNCONFIGURED_LOCALE"
    );
    expect(diagnostics.some((d) => d.message.includes('"de"'))).toBe(true);
  });

  it("stays quiet when every locale folder is configured", async () => {
    const { pages } = await buildProject(config());
    // FILES ships an `fr/` folder, and `fr` is a configured locale.
    expect(i18nDiagnostics(pages, i18nOf())).toEqual([]);
  });

  it("reports a shared duplicate sidebar order once, not once per locale", async () => {
    // The tie lives in untranslated default-locale content, which is padded
    // into the fr tree as fallback — without dedup it would be reported twice.
    const resolved = config();
    const contentRoot = await tempContent({
      "guides/alpha.mdx":
        "---\ntitle: Alpha\nsidebar:\n  order: 1\n---\n# Alpha\n",
      "guides/beta.mdx":
        "---\ntitle: Beta\nsidebar:\n  order: 1\n---\n# Beta\n",
      "index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);
    const graph = buildContentGraph(pages, {
      folderMeta: new Map<string, FolderMeta>(),
      i18n: resolved.i18n,
      navigation: resolved.navigation,
    });
    const duplicates = graph.diagnostics.filter(
      (d) => d.code === "BLUME_DUPLICATE_SIDEBAR_ORDER"
    );
    expect(duplicates).toHaveLength(1);
  });
});

describe("dot parser and shared files", () => {
  it("maps a dotted filename suffix to a locale (dot parser)", async () => {
    const contentRoot = await tempContent({
      "guides/quickstart.fr.mdx": "# Démarrage\n",
      "guides/quickstart.mdx": "# Quickstart\n",
    });
    const { pages } = await discoverIn(contentRoot, config({ parser: "dot" }));
    const byId = new Map(pages.map((page) => [page.source.ref, page]));

    const fr = byId.get("guides/quickstart.fr.mdx");
    expect(fr?.locale).toBe("fr");
    expect(fr?.route).toBe("/fr/guides/quickstart");
    expect(fr?.translationKey).toBe("/guides/quickstart");
    expect(fr?.navPath).toBe("guides/quickstart.mdx");

    const en = byId.get("guides/quickstart.mdx");
    expect(en?.locale).toBe("en");
    expect(en?.route).toBe("/guides/quickstart");
  });

  it("materializes a shared $ file into every locale", async () => {
    const contentRoot = await tempContent({
      "changelog.$.mdx": "# Changelog\n",
      "index.mdx": "# Home\n",
    });
    const { pages } = await discoverIn(contentRoot, config());
    const changelog = pages.filter((p) => p.translationKey === "/changelog");

    expect(changelog.map((p) => p.locale).toSorted()).toEqual(["en", "fr"]);
    expect(changelog.map((p) => p.route).toSorted()).toEqual([
      "/changelog",
      "/fr/changelog",
    ]);
    // Both placements share one source entry id and a locale-stripped navPath.
    expect(new Set(changelog.map((p) => p.id)).size).toBe(1);
    expect(changelog.every((p) => p.navPath === "changelog.mdx")).toBe(true);
  });

  it("applies plain meta.ts to every locale under the dot parser", async () => {
    const resolved = config({ parser: "dot" });
    const contentRoot = await tempContent({
      "guides/intro.fr.mdx": "# Intro fr\n",
      "guides/intro.mdx": "# Intro\n",
      "guides/meta.ts": 'export default { title: "Custom Guides Title" };\n',
    });
    const { pages } = await discoverIn(contentRoot, resolved);
    const folderMeta = await discoverFolderMeta(contentRoot);
    const graph = buildContentGraph(pages, {
      folderMeta: folderMeta.meta,
      i18n: resolved.i18n,
      navigation: resolved.navigation,
      sharedFolderMeta: folderMeta.shared,
    });

    // Translations sit next to originals under `dot`, so a locale-prefixed
    // meta key (`fr/guides`) can never exist — the plain meta must apply to
    // every locale, not just the default one.
    expect(labelsOf(graph.navigationByLocale.en?.sidebar ?? [])).toContain(
      "Custom Guides Title"
    );
    expect(labelsOf(graph.navigationByLocale.fr?.sidebar ?? [])).toContain(
      "Custom Guides Title"
    );
  });

  it("applies shared meta.$.ts to every locale's nav group", async () => {
    const resolved = config();
    const contentRoot = await tempContent({
      "fr/guides/intro.mdx": "# Intro fr\n",
      "guides/intro.mdx": "# Intro\n",
      "guides/meta.$.ts": 'export default { title: "Handbook" };\n',
    });
    const { pages } = await discoverIn(contentRoot, resolved);
    const folderMeta = await discoverFolderMeta(contentRoot);
    const graph = buildContentGraph(pages, {
      folderMeta: folderMeta.meta,
      i18n: resolved.i18n,
      navigation: resolved.navigation,
      sharedFolderMeta: folderMeta.shared,
    });

    expect(labelsOf(graph.navigationByLocale.en?.sidebar ?? [])).toContain(
      "Handbook"
    );
    expect(labelsOf(graph.navigationByLocale.fr?.sidebar ?? [])).toContain(
      "Handbook"
    );
  });

  it("reports an index-title mismatch once, not once per locale", async () => {
    // Under `dot` every locale resolves the same meta entry, and the
    // untranslated index page pads every locale's tree as a fallback fill — a
    // single divergence must not repeat for each configured locale.
    const resolved = config({ parser: "dot" });
    const contentRoot = await tempContent({
      "guides/index.mdx": "---\ntitle: Guide Home\n---\n# Guide Home\n",
      "guides/intro.fr.mdx": "---\ntitle: Intro fr\n---\n# Intro fr\n",
      "guides/intro.mdx": "---\ntitle: Intro\n---\n# Intro\n",
      "guides/meta.ts": 'export default { title: "Guides" };\n',
    });
    const { pages } = await discoverIn(contentRoot, resolved);
    const folderMeta = await discoverFolderMeta(contentRoot);
    const graph = buildContentGraph(pages, {
      folderMeta: folderMeta.meta,
      i18n: resolved.i18n,
      navigation: resolved.navigation,
      sharedFolderMeta: folderMeta.shared,
    });

    const mismatches = graph.diagnostics.filter(
      (d) => d.code === "BLUME_NAV_INDEX_TITLE_MISMATCH"
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.file).toContain("guides/index.mdx");
  });

  it("does not flag a fallback-filled index page against translated meta", async () => {
    // `fr` translated the folder meta but not the index page, so the English
    // page pads the French tree. That drift is a missing translation — telling
    // the author to change the English frontmatter to the French title would
    // break the default locale.
    const resolved = config();
    const contentRoot = await tempContent({
      "fr/guides/meta.ts": 'export default { title: "Guides FR" };\n',
      "guides/index.mdx": "---\ntitle: Guides\n---\n# Guides\n",
      "guides/meta.ts": 'export default { title: "Guides" };\n',
    });
    const { pages } = await discoverIn(contentRoot, resolved);
    const folderMeta = await discoverFolderMeta(contentRoot);
    const graph = buildContentGraph(pages, {
      folderMeta: folderMeta.meta,
      i18n: resolved.i18n,
      navigation: resolved.navigation,
      sharedFolderMeta: folderMeta.shared,
    });

    expect(
      graph.diagnostics.some((d) => d.code === "BLUME_NAV_INDEX_TITLE_MISMATCH")
    ).toBeFalsy();
  });

  it("flags a translated index page drifting from its locale's meta", async () => {
    const resolved = config();
    const contentRoot = await tempContent({
      "fr/guides/index.mdx": "---\ntitle: Accueil\n---\n# Accueil\n",
      "fr/guides/meta.ts": 'export default { title: "Guides FR" };\n',
      "guides/index.mdx": "---\ntitle: Guides\n---\n# Guides\n",
      "guides/meta.ts": 'export default { title: "Guides" };\n',
    });
    const { pages } = await discoverIn(contentRoot, resolved);
    const folderMeta = await discoverFolderMeta(contentRoot);
    const graph = buildContentGraph(pages, {
      folderMeta: folderMeta.meta,
      i18n: resolved.i18n,
      navigation: resolved.navigation,
      sharedFolderMeta: folderMeta.shared,
    });

    const mismatches = graph.diagnostics.filter(
      (d) => d.code === "BLUME_NAV_INDEX_TITLE_MISMATCH"
    );
    expect(mismatches).toHaveLength(1);
    // The drift is the French page's, and the diagnostic must say so.
    expect(mismatches[0]?.file).toContain("fr/guides/index.mdx");
    expect(mismatches[0]?.message).toContain('"Guides FR"');
  });

  it("recognizes a default-locale dot suffix as a locale variant", () => {
    // `intro.en.mdx` + `intro.fr.mdx` is the natural symmetric authoring; the
    // default-locale file must strip its suffix and share the `/intro` key
    // rather than routing to a literal `/intro.en`.
    expect(
      localePlacement("intro.en.mdx", ".mdx", i18nOf({ parser: "dot" }))
    ).toStrictEqual({ locales: ["en"], navPath: "intro.mdx" });
    expect(
      localePlacement("intro.fr.mdx", ".mdx", i18nOf({ parser: "dot" }))
    ).toStrictEqual({ locales: ["fr"], navPath: "intro.mdx" });
    // A non-locale dotted name stays default-locale content, suffix intact.
    expect(
      localePlacement("intro.v2.mdx", ".mdx", i18nOf({ parser: "dot" }))
    ).toStrictEqual({ locales: ["en"], navPath: "intro.v2.mdx" });
  });

  it("matches a mixed-case dot suffix case-insensitively", () => {
    const i18n = i18nOf({
      locales: [
        { code: "en", label: "English" },
        { code: "pt-BR", label: "Português" },
      ],
      parser: "dot",
    });
    // The lowercase suffix matches the configured `pt-BR` and adopts its casing.
    expect(localePlacement("intro.pt-br.mdx", ".mdx", i18n)).toStrictEqual({
      locales: ["pt-BR"],
      navPath: "intro.mdx",
    });
    expect(localePlacement("intro.PT-BR.mdx", ".mdx", i18n)).toStrictEqual({
      locales: ["pt-BR"],
      navPath: "intro.mdx",
    });
  });

  it("hoists a dir-parser locale directory in front of the source prefix", async () => {
    const contentRoot = await tempContent({
      "fr/guides/meta.ts": 'export default { title: "Guides FR" };\n',
      "guides/meta.ts": 'export default { title: "Guides" };\n',
    });
    const { meta } = await discoverFolderMeta(
      [{ prefix: "docs", root: contentRoot }],
      { localeDirs: ["fr"] }
    );
    // Navigation looks locale meta up as `<locale>/<prefixed group path>`, so
    // the on-disk `fr/guides` under a `docs` prefix must key to `fr/docs/guides`.
    expect(meta.get("fr/docs/guides")).toStrictEqual({ title: "Guides FR" });
    expect(meta.get("docs/guides")).toStrictEqual({ title: "Guides" });
  });
});

describe("manifest alternates and fallback", () => {
  it("links translations and materializes a fallback for missing ones", async () => {
    const { manifest } = await buildProject(config());
    const byPath = new Map(manifest.routes.map((route) => [route.path, route]));

    const en = byPath.get("/guides/quickstart");
    expect(en?.alternates.map((alt) => alt.locale).toSorted()).toEqual([
      "en",
      "fr",
    ]);

    // `only-en` has no French translation, so a fallback route is rendered at
    // the localized URL, pointing at the English entry, not indexed.
    const fallback = byPath.get("/fr/guides/only-en");
    expect(fallback?.fallback).toBe(true);
    expect(fallback?.locale).toBe("fr");
    expect(fallback?.source.ref).toBe("guides/only-en.mdx");
    expect(fallback?.indexable).toBe(false);
  });

  it("emits no fallback routes when fallback is disabled", async () => {
    const { manifest } = await buildProject(config({ fallbackLocale: null }));
    expect(manifest.routes.some((route) => route.fallback)).toBe(false);
    expect(
      manifest.routes.some((route) => route.path === "/fr/guides/only-en")
    ).toBe(false);
  });
});

describe("UI dictionaries", () => {
  it("uses the English baseline for the default locale", () => {
    const dict = resolveUIStrings("en", { defaultLocale: "en" });
    expect(dict.search.button).toBe(EN_UI.search.button);
    expect(dict.page.previous).toBe("Previous");
  });

  it("fully populates every field of the English baseline", () => {
    // Regression: EN_UI is derived by naming each group explicitly so that the
    // inner field `.default()`s apply. Zod 4's `.default({})` no longer recurses
    // into the inner type, so a bare `uiStringsObject.parse({})` would collapse
    // each group to `{}` — and since layout components resolve Zod from the
    // consuming project, a ui-less PageLayout would then render blank chrome
    // (empty search labels/aria-labels, empty skip link).
    const groups = Object.entries(
      EN_UI as unknown as Record<string, Record<string, string>>
    );
    expect(groups.length).toBeGreaterThan(0);
    for (const [group, values] of groups) {
      expect(
        Object.keys(values).length,
        `group "${group}" is empty`
      ).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(values)) {
        expect(value, `${group}.${key} is blank`).toBeTruthy();
      }
    }
    expect(EN_UI.search.button).toBe("Search");
    expect(EN_UI.search.placeholder).toBe("Search documentation…");
    expect(EN_UI.page.skipToContent).toBe("Skip to content");
  });

  it("includes English defaults for the chrome strings added post-launch", () => {
    // Formerly hardcoded in components; now dictionary-driven with English
    // fallback (packs may omit them and still merge cleanly).
    expect(EN_UI.actions.export).toBe("Export");
    expect(EN_UI.actions.generating).toBe("Generating…");
    expect(EN_UI.nav.sections).toBe("Sections");
    expect(EN_UI.nav.toggleTheme).toBe("Toggle color theme");
    expect(EN_UI.search.results).toBe("Results");
    expect(EN_UI.search.error).toBe("Something went wrong. Please try again.");
    // Parameterized: `{version}` is replaced with the major line at render time.
    expect(EN_UI.changelog.showReleases).toContain("{version}");
    expect(EN_UI.content.diagramError).toBe("Could not render this diagram.");
    expect(EN_UI.ask.you).toBe("You");
    // A pack shipped before these keys existed still resolves them to English.
    const dict = resolveUIStrings("de", { defaultLocale: "en" });
    expect(dict.nav.back).toBe("Back");
    expect(dict.search.popular).toBe("Popular");
  });

  it("localizes the banner dismiss label in every shipped pack", () => {
    // Formerly hardcoded "Dismiss announcement" in Banner.astro; now
    // dictionary-driven so localized sites get localized banner chrome.
    expect(EN_UI.banner.dismiss).toBe("Dismiss announcement");
    const de = resolveUIStrings("de", { defaultLocale: "en" });
    expect(de.banner.dismiss).toBe("Ankündigung schließen");
    for (const [code, pack] of Object.entries(UI_PACKS)) {
      expect(
        pack.banner?.dismiss,
        `pack "${code}" misses banner.dismiss`
      ).toBeTruthy();
    }
  });

  it("localizes the landmark labels and changelog chrome in every shipped pack", () => {
    // Formerly hardcoded English: the breadcrumb/pagination nav landmarks, the
    // search section-filter "All" pill, and the generated changelog index's
    // heading/description. Now dictionary-driven with English fallback.
    expect(EN_UI.search.all).toBe("All");
    expect(EN_UI.nav.breadcrumb).toBe("Breadcrumb");
    expect(EN_UI.page.pagination).toBe("Pagination");
    expect(EN_UI.changelog.title).toBe("Changelog");
    expect(EN_UI.changelog.description).toBe(
      "Product updates, new features, and fixes from every release."
    );
    const dict = resolveUIStrings("fr", { defaultLocale: "en" });
    expect(dict.nav.breadcrumb).toBe("Fil d'Ariane");
    expect(dict.changelog.title).toBe("Journal des modifications");
    for (const [code, pack] of Object.entries(UI_PACKS)) {
      expect(pack.search?.all, `pack "${code}" misses search.all`).toBeTruthy();
      expect(
        pack.nav?.breadcrumb,
        `pack "${code}" misses nav.breadcrumb`
      ).toBeTruthy();
      expect(
        pack.page?.pagination,
        `pack "${code}" misses page.pagination`
      ).toBeTruthy();
      expect(
        pack.changelog?.title,
        `pack "${code}" misses changelog.title`
      ).toBeTruthy();
      expect(
        pack.changelog?.description,
        `pack "${code}" misses changelog.description`
      ).toBeTruthy();
    }
  });

  it("applies a shipped pack for a translated locale", () => {
    const dict = resolveUIStrings("fr", { defaultLocale: "en" });
    expect(dict.search.button).toBe("Rechercher");
    expect(dict.page.next).toBe("Suivant");
  });

  it("lets user overrides win over the pack", () => {
    const dict = resolveUIStrings("fr", {
      defaultLocale: "en",
      overrides: { fr: { search: { button: "Chercher" } } },
    });
    expect(dict.search.button).toBe("Chercher");
    // Untranslated keys still fall back to the pack, then English.
    expect(dict.page.next).toBe("Suivant");
  });

  it("ships packs for a broad set of locales", () => {
    // A representative spread across scripts/regions; not the whole list.
    const sample = ["de", "es", "ja", "zh", "zh-TW", "ar", "ru", "pt-BR"];
    for (const code of sample) {
      expect(UI_PACKS[code]).toBeDefined();
    }
    expect(Object.keys(UI_PACKS).length).toBeGreaterThan(20);
  });

  it("resolves a non-French shipped pack", () => {
    const de = resolveUIStrings("de", { defaultLocale: "en" });
    expect(de.search.button).toBe("Suchen");
    expect(de.page.previous).toBe("Zurück");

    const ja = resolveUIStrings("ja", { defaultLocale: "en" });
    expect(ja.toc.title).toBe("このページの内容");
    // Brand names stay verbatim inside translated strings.
    expect(ja.actions.edit).toContain("GitHub");
  });

  it("resolves a regional variant pack by its BCP 47 code", () => {
    const dict = resolveUIStrings("zh-TW", { defaultLocale: "en" });
    expect(dict.search.button).toBe("搜尋");
  });

  it("falls back to English for a locale with no shipped pack", () => {
    const dict = resolveUIStrings("xx", { defaultLocale: "en" });
    expect(dict.search.button).toBe(EN_UI.search.button);
    expect(dict.page.next).toBe("Next");
  });

  it("resolves a region variant to its base-language pack", () => {
    // No fr-CA pack ships, so it should use the French pack, not English.
    const dict = resolveUIStrings("fr-CA", { defaultLocale: "en" });
    expect(dict.search.button).toBe("Rechercher");
  });

  it("matches a pack code case-insensitively", () => {
    // `pt-br` should still find the `pt-BR` pack.
    const dict = resolveUIStrings("pt-br", { defaultLocale: "en" });
    expect(dict.page.next).toBe(
      resolveUIStrings("pt-BR", { defaultLocale: "en" }).page.next
    );
  });

  it("every shipped pack uses only known UI keys", () => {
    const baseline = EN_UI as Record<string, Record<string, string>>;
    const violations: string[] = [];
    for (const [code, pack] of Object.entries(UI_PACKS)) {
      for (const [group, values] of Object.entries(pack)) {
        const known = baseline[group];
        if (!known) {
          violations.push(`${code}: unknown group "${group}"`);
          continue;
        }
        for (const key of Object.keys(values)) {
          if (!(key in known)) {
            violations.push(`${code}.${group}: unknown key "${key}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
