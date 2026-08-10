import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildRuntimeData } from "../src/astro/generate.ts";
import { catchAllPageTemplate } from "../src/astro/templates.ts";
import { discoverContent } from "../src/core/content.ts";
import { buildContentGraph } from "../src/core/graph.ts";
import { i18nDiagnostics } from "../src/core/i18n.ts";
import { buildManifest } from "../src/core/manifest.ts";
import { discoverFolderMeta } from "../src/core/meta.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type {
  ResolvedConfig,
  ResolvedVersionsConfig,
} from "../src/core/schema.ts";
import type {
  BlumeManifest,
  PageRecord,
  ProjectContext,
  RouteManifestEntry,
} from "../src/core/types.ts";
import {
  archivedIds,
  archivedVersion,
  detectVersion,
  detectVersionRef,
  versionLabel,
  versionRoot,
  versionizeRoute,
  versionsDiagnostics,
  versionsEnabled,
} from "../src/core/versions.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";
import { buildOramaIndex, queryOramaIndex } from "../src/search/orama-index.ts";

const config = (
  over: Record<string, unknown> = {},
  topLevel: Record<string, unknown> = {}
): ResolvedConfig =>
  blumeConfigSchema.parse({
    ...topLevel,
    versions: {
      archived: [{ id: "v1.0" }, { id: "v0.9", label: "0.9 (legacy)" }],
      current: { badge: "Latest", label: "v2.0" },
      ...over,
    },
  });

const versionsOf = (
  over: Record<string, unknown> = {}
): ResolvedVersionsConfig => {
  const value = config(over).versions;
  if (!value) {
    throw new Error("expected versions");
  }
  return value;
};

const pageWithRef = (ref: string): PageRecord =>
  ({ source: { name: "filesystem", ref } }) as PageRecord;

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** Write a content tree to a fresh temp dir and return its content root. */
const tempContent = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-versions-"));
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
    versions: resolved.versions,
  });

const page = (pages: PageRecord[], route: string): PageRecord => {
  const found = pages.find((candidate) => candidate.route === route);
  if (!found) {
    throw new Error(
      `no page at ${route}; got ${pages.map((p) => p.route).join(", ")}`
    );
  }
  return found;
};

const I18N = {
  defaultLocale: "en",
  locales: [
    { code: "en", label: "English" },
    { code: "fr", label: "Français" },
  ],
};

/** Discover content + folder meta and build the graph, like scanProject does. */
const graphIn = async (contentRoot: string, resolved: ResolvedConfig) => {
  const { pages } = await discoverIn(contentRoot, resolved);
  const folderMeta = await discoverFolderMeta(contentRoot, {
    localeDirs:
      resolved.i18n && resolved.i18n.parser === "dir"
        ? resolved.i18n.locales.flatMap((locale) =>
            locale.code === resolved.i18n?.defaultLocale ? [] : [locale.code]
          )
        : undefined,
    versionDirs: resolved.versions?.archived.map((version) => version.id),
  });
  return buildContentGraph(pages, {
    folderMeta: folderMeta.meta,
    i18n: resolved.i18n,
    navigation: resolved.navigation,
    sharedFolderMeta: folderMeta.shared,
    versions: resolved.versions,
  });
};

const labelsOf = (nodes: { label: string }[] | undefined): string[] =>
  (nodes ?? []).map((node) => node.label);

describe("versions config schema", () => {
  it("applies defaults to archived versions", () => {
    const versions = versionsOf();
    expect(versions.archived[0]).toEqual({
      banner: true,
      canonical: "latest",
      id: "v1.0",
      noindex: false,
    });
    expect(versions.switcher).toEqual({ redirect: "same-page" });
  });

  it("accepts custom banner copy, canonical self, and noindex", () => {
    const versions = versionsOf({
      archived: [
        {
          banner: "Old docs — here be dragons.",
          canonical: "self",
          id: "v1.0",
          noindex: true,
        },
      ],
    });
    expect(versions.archived[0]).toMatchObject({
      banner: "Old docs — here be dragons.",
      canonical: "self",
      noindex: true,
    });
  });

  it("defaults archived to an empty list", () => {
    const versions = versionsOf({ archived: undefined });
    expect(versions.archived).toEqual([]);
  });

  it("rejects a version id starting with a digit", () => {
    const parsed = blumeConfigSchema.safeParse({
      versions: {
        archived: [{ id: "1.0" }],
        current: { label: "v2.0" },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain(
        "must start with a letter"
      );
    }
  });

  it("rejects a version id with a slash", () => {
    const parsed = blumeConfigSchema.safeParse({
      versions: {
        archived: [{ id: "v1/0" }],
        current: { label: "v2.0" },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate archived ids", () => {
    const parsed = blumeConfigSchema.safeParse({
      versions: {
        archived: [{ id: "v1.0" }, { id: "v1.0" }],
        current: { label: "v2.0" },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("more than once");
    }
  });

  it("rejects a version id that is also a configured locale code", () => {
    const parsed = blumeConfigSchema.safeParse({
      i18n: {
        defaultLocale: "en",
        locales: [
          { code: "en", label: "English" },
          { code: "FR", label: "Français" },
        ],
      },
      versions: {
        archived: [{ id: "fr" }],
        current: { label: "v2.0" },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain(
        "also a configured locale code"
      );
    }
  });
});

describe("versionsEnabled", () => {
  it("narrows on the versions field", () => {
    expect(versionsEnabled(config())).toBe(true);
    expect(versionsEnabled(blumeConfigSchema.parse({}))).toBe(false);
  });
});

describe("archivedIds", () => {
  it("returns ids in configured order", () => {
    expect(archivedIds(versionsOf())).toEqual(["v1.0", "v0.9"]);
  });
});

describe("versionLabel", () => {
  it("labels the current version from config", () => {
    expect(versionLabel("", versionsOf())).toBe("v2.0");
  });

  it("falls back to the id when an archived version has no label", () => {
    expect(versionLabel("v1.0", versionsOf())).toBe("v1.0");
  });

  it("uses the configured label when present", () => {
    expect(versionLabel("v0.9", versionsOf())).toBe("0.9 (legacy)");
  });

  it("returns the id for an unknown version", () => {
    expect(versionLabel("v9.9", versionsOf())).toBe("v9.9");
  });
});

describe("archivedVersion", () => {
  it("resolves an archived id and misses current/unknown", () => {
    expect(archivedVersion("v1.0", versionsOf())?.id).toBe("v1.0");
    expect(archivedVersion("", versionsOf())).toBeUndefined();
    expect(archivedVersion("v9.9", versionsOf())).toBeUndefined();
  });
});

describe("detectVersion", () => {
  it("strips a leading archived version directory", () => {
    expect(detectVersion(["v1.0", "guides", "x.mdx"], versionsOf())).toEqual({
      rest: ["guides", "x.mdx"],
      version: "v1.0",
    });
  });

  it("treats unknown leading segments as current-version content", () => {
    expect(detectVersion(["guides", "x.mdx"], versionsOf())).toEqual({
      rest: ["guides", "x.mdx"],
      version: "",
    });
  });

  it("matches ids exactly, not case-insensitively", () => {
    // Version ids are directory names, verbatim — unlike BCP 47 locale codes
    // there is no case-folding convention to honor.
    expect(detectVersion(["V1.0", "x.mdx"], versionsOf()).version).toBe("");
  });

  it("handles an empty path", () => {
    expect(detectVersion([], versionsOf())).toEqual({ rest: [], version: "" });
  });
});

describe("versionizeRoute", () => {
  it("prefixes routes with the version", () => {
    expect(versionizeRoute("/guides/x", "v1.0")).toBe("/v1.0/guides/x");
  });

  it("maps the root route to the bare version segment", () => {
    expect(versionizeRoute("/", "v1.0")).toBe("/v1.0");
  });

  it("is the identity for the current version", () => {
    expect(versionizeRoute("/guides/x", "")).toBe("/guides/x");
    expect(versionizeRoute("/", "")).toBe("/");
  });
});

describe("versionRoot", () => {
  const { i18n } = blumeConfigSchema.parse({
    i18n: {
      defaultLocale: "en",
      locales: [
        { code: "en", label: "English" },
        { code: "fr", label: "Français" },
      ],
    },
  });

  it("returns the bare roots without i18n", () => {
    expect(versionRoot("")).toBe("/");
    expect(versionRoot("v1.0")).toBe("/v1.0");
  });

  it("keeps the locale prefix outermost", () => {
    if (!i18n) {
      throw new Error("expected i18n");
    }
    expect(versionRoot("v1.0", "fr", i18n)).toBe("/fr/v1.0");
    expect(versionRoot("", "fr", i18n)).toBe("/fr");
    expect(versionRoot("v1.0", "en", i18n)).toBe("/v1.0");
  });
});

describe("detectVersionRef", () => {
  it("splits a versioned ref and rejoins the rest", () => {
    expect(detectVersionRef("v1.0/guides/x.mdx", versionsOf())).toEqual({
      rest: "guides/x.mdx",
      version: "v1.0",
    });
    expect(detectVersionRef("guides/x.mdx", versionsOf())).toEqual({
      rest: "guides/x.mdx",
      version: "",
    });
  });
});

describe("normalizeEntry with versions", () => {
  it("routes snapshot pages under the version with a version-agnostic key", async () => {
    const resolved = config();
    const contentRoot = await tempContent({
      "guides/x.mdx": "---\ntitle: X\n---\n# X\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X v1\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);

    const current = page(pages, "/guides/x");
    expect(current.version).toBe("");
    expect(current.versionKey).toBe("/guides/x");
    expect(current.translationKey).toBe("/guides/x");

    const archived = page(pages, "/v1.0/guides/x");
    expect(archived.version).toBe("v1.0");
    expect(archived.versionKey).toBe("/guides/x");
    expect(archived.translationKey).toBe("/v1.0/guides/x");
    // The version dir is shed from navPath so it never becomes a sidebar group.
    expect(archived.navPath).toBe("guides/x.mdx");
  });

  it("keeps the locale prefix outermost under the dir parser", async () => {
    const resolved = config({}, { i18n: I18N });
    const contentRoot = await tempContent({
      "v1.0/fr/guides/x.mdx": "---\ntitle: X v1 fr\n---\n# X\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);

    const english = page(pages, "/v1.0/guides/x");
    expect(english).toMatchObject({
      locale: "en",
      translationKey: "/v1.0/guides/x",
      version: "v1.0",
      versionKey: "/guides/x",
    });

    const french = page(pages, "/fr/v1.0/guides/x");
    expect(french).toMatchObject({
      locale: "fr",
      translationKey: "/v1.0/guides/x",
      version: "v1.0",
      versionKey: "/guides/x",
    });
    expect(french.navPath).toBe("guides/x.mdx");
  });

  it("resolves dot-parser locale suffixes inside a snapshot", async () => {
    const resolved = config({}, { i18n: { ...I18N, parser: "dot" } });
    const contentRoot = await tempContent({
      "v1.0/guides/x.fr.mdx": "---\ntitle: X v1 fr\n---\n# X\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);

    expect(page(pages, "/fr/v1.0/guides/x")).toMatchObject({
      locale: "fr",
      version: "v1.0",
      versionKey: "/guides/x",
    });
    expect(page(pages, "/v1.0/guides/x").locale).toBe("en");
  });

  it("fans a shared `$` file inside a snapshot out to every locale", async () => {
    const resolved = config({}, { i18n: I18N });
    const contentRoot = await tempContent({
      "v1.0/changelog.$.mdx": "---\ntitle: Changelog\n---\n# Changelog\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);

    expect(page(pages, "/v1.0/changelog").locale).toBe("en");
    expect(page(pages, "/fr/v1.0/changelog").locale).toBe("fr");
    expect(pages).toHaveLength(2);
    for (const record of pages) {
      expect(record.version).toBe("v1.0");
      expect(record.versionKey).toBe("/changelog");
    }
  });

  it("versionizes a frontmatter slug so snapshots cannot shadow live pages", async () => {
    const resolved = config();
    const contentRoot = await tempContent({
      "custom.mdx": "---\ntitle: Custom\nslug: custom\n---\n# Custom\n",
      "v1.0/custom.mdx": "---\ntitle: Old\nslug: custom\n---\n# Old\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);

    expect(page(pages, "/custom").version).toBe("");
    expect(page(pages, "/v1.0/custom")).toMatchObject({
      version: "v1.0",
      versionKey: "/custom",
    });
  });

  it("maps a snapshot index to the bare version route", async () => {
    const resolved = config();
    const contentRoot = await tempContent({
      "v1.0/index.mdx": "---\ntitle: Home v1\n---\n# Home\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);

    expect(page(pages, "/v1.0")).toMatchObject({
      version: "v1.0",
      versionKey: "/",
    });
  });

  it("strips numeric ordering prefixes inside snapshots, not the version dir", async () => {
    const resolved = config();
    const contentRoot = await tempContent({
      "v1.0/01-intro.mdx": "---\ntitle: Intro\n---\n# Intro\n",
    });
    const { pages } = await discoverIn(contentRoot, resolved);

    expect(page(pages, "/v1.0/intro").version).toBe("v1.0");
  });
});

describe("buildContentGraph with versions", () => {
  it("partitions pages into current and per-version trees", async () => {
    const resolved = config();
    const contentRoot = await tempContent({
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n",
      "index.mdx": "---\ntitle: Home\n---\n# Home\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
      "v1.0/old-only.mdx": "---\ntitle: Old Only\n---\n# Old\n",
    });
    const graph = await graphIn(contentRoot, resolved);

    // The current sidebar holds only current pages — no `v1.0` group, no
    // duplicate entry for the shared logical page.
    const currentLabels = labelsOf(graph.navigation.sidebar);
    expect(currentLabels).toContain("Home");
    expect(currentLabels).not.toContain("Old Only");
    expect(currentLabels.filter((label) => label === "v1.0")).toHaveLength(0);

    const archived = graph.navigationByVersion["v1.0"]?.[""];
    expect(archived).toBeDefined();
    const archivedLabels = labelsOf(archived?.sidebar);
    expect(archivedLabels).toContain("Old Only");
    expect(archivedLabels).not.toContain("Home");
    // The snapshot tree roots at the version, not "/".
    expect(archived?.root).toBe("/v1.0");
  });

  it("builds per-locale trees inside a snapshot with fallback padding", async () => {
    const resolved = config({}, { i18n: I18N });
    const contentRoot = await tempContent({
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n",
      "v1.0/fr/guides/x.mdx": "---\ntitle: X v1 fr\n---\n# X\n",
      "v1.0/guides/only-en.mdx": "---\ntitle: Only EN v1\n---\n# Only\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
    });
    const graph = await graphIn(contentRoot, resolved);

    const french = graph.navigationByVersion["v1.0"]?.fr;
    expect(french?.root).toBe("/fr/v1.0");
    const group = french?.sidebar.find((node) => node.kind === "group");
    const childLabels = group?.kind === "group" ? labelsOf(group.children) : [];
    expect(childLabels).toContain("X v1 fr");
    // The untranslated snapshot page is padded from the fallback locale at a
    // version-correct route.
    expect(childLabels).toContain("Only EN v1");
    const padded =
      group?.kind === "group"
        ? group.children.find((node) => node.label === "Only EN v1")
        : undefined;
    expect(padded?.kind === "page" ? padded.route : undefined).toBe(
      "/fr/v1.0/guides/only-en"
    );
  });

  it("applies snapshot folder meta through the version-hoisted keys", async () => {
    const resolved = config({}, { i18n: I18N });
    const contentRoot = await tempContent({
      "guides/meta.ts": 'export default { title: "Current Guides" };\n',
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n",
      "v1.0/fr/guides/meta.ts": 'export default { title: "Guides v1 fr" };\n',
      "v1.0/fr/guides/x.mdx": "---\ntitle: X v1 fr\n---\n# X\n",
      "v1.0/guides/meta.$.ts":
        'export default { title: "Shared v1 Guides" };\n',
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
    });
    const graph = await graphIn(contentRoot, resolved);

    // Current tree: its own meta, untouched by the snapshot's.
    expect(labelsOf(graph.navigationByLocale.en?.sidebar)).toContain(
      "Current Guides"
    );
    // Snapshot default locale: shared `meta.$.*` keyed under the version dir.
    expect(labelsOf(graph.navigationByVersion["v1.0"]?.en?.sidebar)).toContain(
      "Shared v1 Guides"
    );
    // Snapshot French: locale-specific meta wins over the shared one.
    expect(labelsOf(graph.navigationByVersion["v1.0"]?.fr?.sidebar)).toContain(
      "Guides v1 fr"
    );
  });

  it("ignores a configured explicit sidebar inside snapshots", async () => {
    const resolved = blumeConfigSchema.parse({
      navigation: {
        sidebar: { items: ["guides/x"] },
      },
      versions: {
        archived: [{ id: "v1.0" }],
        current: { label: "v2.0" },
      },
    });
    const contentRoot = await tempContent({
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n",
      "hidden-from-config.mdx": "---\ntitle: Unlisted\n---\n# U\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
    });
    const graph = await graphIn(contentRoot, resolved);

    // The configured sidebar drives the current tree…
    expect(labelsOf(graph.navigation.sidebar)).not.toContain("Unlisted");
    // …while the snapshot falls back to its own filesystem structure.
    const archivedGroup = graph.navigationByVersion["v1.0"]?.[""]?.sidebar.find(
      (node) => node.kind === "group"
    );
    expect(
      archivedGroup?.kind === "group" ? labelsOf(archivedGroup.children) : []
    ).toContain("X v1");
  });
});

const manifestIn = async (contentRoot: string, resolved: ResolvedConfig) => {
  const graph = await graphIn(contentRoot, resolved);
  return buildManifest({
    config: resolved,
    context: { contentRoot, root: dirname(contentRoot) } as ProjectContext,
    graph,
  });
};

const routeAt = (manifest: BlumeManifest, path: string): RouteManifestEntry => {
  const route = manifest.routes.find((candidate) => candidate.path === path);
  if (!route) {
    throw new Error(
      `no route at ${path}; got ${manifest.routes.map((r) => r.path).join(", ")}`
    );
  }
  return route;
};

describe("buildManifest with versions", () => {
  it("links the same logical page across versions, current first", async () => {
    const resolved = config();
    const contentRoot = await tempContent({
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n",
      "v0.9/guides/x.mdx": "---\ntitle: X v0.9\n---\n# X\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
      "v1.0/old-only.mdx": "---\ntitle: Old Only\n---\n# Old\n",
    });
    const manifest = await manifestIn(contentRoot, resolved);

    const current = routeAt(manifest, "/guides/x");
    expect(current.version).toBe("");
    expect(current.versionAlternates).toEqual([
      { path: "/guides/x", version: "" },
      { path: "/v1.0/guides/x", version: "v1.0" },
      { path: "/v0.9/guides/x", version: "v0.9" },
    ]);
    // Both directions share the list: the archived page sees the same set.
    expect(routeAt(manifest, "/v1.0/guides/x").versionAlternates).toEqual(
      current.versionAlternates
    );
    // A version-only page has just itself.
    expect(routeAt(manifest, "/v1.0/old-only").versionAlternates).toEqual([
      { path: "/v1.0/old-only", version: "v1.0" },
    ]);
  });

  it("keeps version alternates locale-scoped and includes fallback routes", async () => {
    const resolved = config({ archived: [{ id: "v1.0" }] }, { i18n: I18N });
    const contentRoot = await tempContent({
      "fr/guides/x.mdx": "---\ntitle: X v2 fr\n---\n# X\n",
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
    });
    const manifest = await manifestIn(contentRoot, resolved);

    // French current page: its v1.0 sibling is a fallback-materialized route,
    // which still registers at its own localized URL.
    expect(routeAt(manifest, "/fr/guides/x").versionAlternates).toEqual([
      { path: "/fr/guides/x", version: "" },
      { path: "/fr/v1.0/guides/x", version: "v1.0" },
    ]);
    const padded = routeAt(manifest, "/fr/v1.0/guides/x");
    expect(padded.fallback).toBe(true);
    expect(padded.version).toBe("v1.0");
    // English lists stay separate from French ones.
    expect(routeAt(manifest, "/guides/x").versionAlternates).toEqual([
      { path: "/guides/x", version: "" },
      { path: "/v1.0/guides/x", version: "v1.0" },
    ]);
  });

  it("emits empty version alternates when versioning is off", async () => {
    const resolved = blumeConfigSchema.parse({ i18n: I18N });
    const contentRoot = await tempContent({
      "fr/guides/x.mdx": "---\ntitle: X fr\n---\n# X\n",
      "guides/x.mdx": "---\ntitle: X\n---\n# X\n",
      "guides/y.mdx": "---\ntitle: Y\n---\n# Y\n",
    });
    const manifest = await manifestIn(contentRoot, resolved);
    for (const route of manifest.routes) {
      expect(route.version).toBe("");
      expect(route.versionAlternates).toEqual([]);
    }
  });
});

describe("scanProject with versions", () => {
  it("runs the full pipeline and warns on an unregistered snapshot dir", async () => {
    const contentRoot = await tempContent({
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n",
      "v1.0/guides/meta.ts": 'export default { title: "Guides v1" };\n',
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
      "v3/stray.mdx": "---\ntitle: Stray\n---\n# Stray\n",
    });
    const root = dirname(contentRoot);
    await writeFile(
      join(root, "blume.config.ts"),
      `export default {
        versions: {
          archived: [{ id: "v1.0" }],
          current: { label: "v2.0" },
        },
      };\n`
    );

    const project = await scanProject(root, { mode: "build" });
    const paths = project.manifest.routes.map((route) => route.path);
    expect(paths).toContain("/guides/x");
    expect(paths).toContain("/v1.0/guides/x");
    // The snapshot's folder meta reached the versioned tree through the
    // version-hoisted key space discovered by scanProject itself.
    expect(
      labelsOf(project.graph.navigationByVersion["v1.0"]?.[""]?.sidebar)
    ).toContain("Guides v1");
    // `v3/` looks like a snapshot but is not registered in versions.archived.
    expect(project.diagnostics.map((d) => d.code)).toContain(
      "BLUME_VERSIONS_UNCONFIGURED_VERSION"
    );
  });
});

describe("runtime data with versions", () => {
  it("serializes version config, per-version trees, and route alternates", async () => {
    const contentRoot = await tempContent({
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n",
      "v1.0/guides/x.mdx": "---\ntitle: X v1\n---\n# X\n",
    });
    const root = dirname(contentRoot);
    await writeFile(
      join(root, "blume.config.ts"),
      `export default {
        versions: {
          archived: [{ id: "v1.0", label: "1.0" }],
          current: { badge: "Latest", label: "2.0" },
        },
      };\n`
    );

    const project = await scanProject(root, { mode: "build" });
    const data = JSON.parse(buildRuntimeData(project));

    expect(data.config.versions.current).toEqual({
      badge: "Latest",
      label: "2.0",
    });
    expect(data.config.versions.archived[0]).toMatchObject({
      id: "v1.0",
      label: "1.0",
    });
    expect(data.navigationByVersion["v1.0"]?.[""]?.root).toBe("/v1.0");

    const archivedRoute = data.routes.find(
      (route: { path: string }) => route.path === "/v1.0/guides/x"
    );
    expect(archivedRoute.version).toBe("v1.0");
    expect(archivedRoute.versionAlternates).toEqual([
      { path: "/guides/x", version: "" },
      { path: "/v1.0/guides/x", version: "v1.0" },
    ]);
  });

  it("serializes null versions and empty trees when versioning is off", async () => {
    const contentRoot = await tempContent({
      "index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const project = await scanProject(dirname(contentRoot), { mode: "build" });
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.versions).toBeNull();
    expect(data.navigationByVersion).toEqual({});
  });
});

describe("catch-all template with versions", () => {
  it("threads version props into the page and layout", () => {
    const template = catchAllPageTemplate({
      exportEpub: false,
      exportPdf: false,
      mathEnabled: false,
      needsReact: false,
    });
    // getStaticPaths forwards the route's version identity…
    expect(template).toContain("version: route.version");
    expect(template).toContain("versionAlternates: route.versionAlternates");
    // …the canonical of an archived page can point at the latest equivalent…
    expect(template).toContain('archived.canonical === "latest"');
    // …and the layout receives the switcher, notice, and effective noindex.
    expect(template).toContain("versionSelector={versionSelector}");
    expect(template).toContain("versionNotice={versionNotice}");
    expect(template).toContain("noindex={effectiveNoindex}");
    expect(template).toContain("data.navigationByVersion[version]");
  });
});

describe("version-scoped search", () => {
  it("filters the orama index by version, including the current docs", async () => {
    const contentRoot = await tempContent({
      "guides/x.mdx": "---\ntitle: X v2\n---\n# X\n\nWidget frobnication.\n",
      "v1.0/guides/x.mdx":
        "---\ntitle: X v1\n---\n# X\n\nWidget frobnication.\n",
    });
    const root = dirname(contentRoot);
    await writeFile(
      join(root, "blume.config.ts"),
      `export default {
        versions: {
          archived: [{ id: "v1.0" }],
          current: { label: "v2.0" },
        },
      };\n`
    );
    const project = await scanProject(root, { mode: "build" });
    const documents = await buildSearchDocuments(project);

    expect(documents.find((doc) => doc.route === "/guides/x")?.version).toBe(
      ""
    );
    expect(
      documents.find((doc) => doc.route === "/v1.0/guides/x")?.version
    ).toBe("v1.0");

    const db = await buildOramaIndex(documents);
    const current = await queryOramaIndex(db, "widget", 10, { version: "" });
    expect(current.map((doc) => doc.route)).toEqual(["/guides/x"]);
    const archived = await queryOramaIndex(db, "widget", 10, {
      version: "v1.0",
    });
    expect(archived.map((doc) => doc.route)).toEqual(["/v1.0/guides/x"]);
    const all = await queryOramaIndex(db, "widget", 10);
    expect(all.map((doc) => doc.route).toSorted()).toEqual([
      "/guides/x",
      "/v1.0/guides/x",
    ]);
  });
});

describe("i18nDiagnostics with versions", () => {
  it("sees locale-shaped folders through a version segment", () => {
    const pages = [
      pageWithRef("v1.0/pt/x.mdx"),
      pageWithRef("v1.0/fr/x.mdx"),
      pageWithRef("fr/x.mdx"),
    ];
    const resolved = config({}, { i18n: I18N });
    if (!resolved.i18n) {
      throw new Error("expected i18n");
    }
    const diagnostics = i18nDiagnostics(
      pages,
      resolved.i18n,
      resolved.versions
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('"pt/"');
  });
});

describe("versionsDiagnostics", () => {
  it("warns once per unconfigured version-shaped folder", () => {
    const pages = [
      pageWithRef("v3/intro.mdx"),
      pageWithRef("v3/guides/x.mdx"),
      pageWithRef("v1.0/intro.mdx"),
      pageWithRef("guides/x.mdx"),
    ];
    const diagnostics = versionsDiagnostics(pages, versionsOf());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "BLUME_VERSIONS_UNCONFIGURED_VERSION",
      severity: "warning",
    });
    expect(diagnostics[0]?.message).toContain('"v3/"');
  });

  it("stays quiet for configured snapshots and ordinary folders", () => {
    const pages = [
      pageWithRef("v1.0/intro.mdx"),
      pageWithRef("v0.9/intro.mdx"),
      pageWithRef("guides/x.mdx"),
      pageWithRef("index.mdx"),
    ];
    expect(versionsDiagnostics(pages, versionsOf())).toEqual([]);
  });
});
