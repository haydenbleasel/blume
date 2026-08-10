import { describe, expect, it } from "bun:test";

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
  versionLabel,
  versionRoot,
  versionizeRoute,
  versionsDiagnostics,
  versionsEnabled,
} from "../src/core/versions.ts";

const config = (over: Record<string, unknown> = {}): ResolvedConfig =>
  blumeConfigSchema.parse({
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
