import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { discoverContent } from "../src/core/content.ts";
import { i18nDiagnostics } from "../src/core/i18n.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type {
  ResolvedConfig,
  ResolvedVersionsConfig,
} from "../src/core/schema.ts";
import type { PageRecord } from "../src/core/types.ts";
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
