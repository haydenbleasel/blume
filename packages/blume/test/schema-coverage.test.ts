import { describe, expect, it } from "bun:test";

import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";

describe("dateSchema normalization", () => {
  it("passes a string date through unchanged", () => {
    const meta = pageMetaSchema.parse({ date: "2026-01-01" });
    expect(meta.date).toBe("2026-01-01");
  });

  it("normalizes a Date (YAML-parsed) to an ISO string", () => {
    const when = new Date("2026-01-02T03:04:05.000Z");
    const meta = pageMetaSchema.parse({ lastModified: when });
    expect(meta.lastModified).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("authors frontmatter", () => {
  it("preserves a single string author", () => {
    const meta = pageMetaSchema.parse({ authors: "ada" });
    expect(meta.authors).toBe("ada");
  });

  it("preserves an array of author objects with extra fields", () => {
    const authors = [
      { name: "Ada Lovelace", twitter: "@ada", url: "https://ada.dev" },
    ];
    const meta = pageMetaSchema.parse({ authors });
    expect(meta.authors).toStrictEqual(authors);
  });

  it("still rejects an unknown top-level key", () => {
    expect(pageMetaSchema.safeParse({ unknownKey: 1 }).success).toBeFalsy();
  });
});

describe("banner", () => {
  it("keeps the supported content/link/dismissible fields", () => {
    const config = blumeConfigSchema.parse({
      banner: { content: "Beta", dismissible: true, id: "beta" },
    });
    expect(config.banner).toStrictEqual({
      content: "Beta",
      dismissible: true,
      id: "beta",
    });
  });

  it("rejects the removed color/type sub-fields", () => {
    expect(
      blumeConfigSchema.safeParse({
        banner: { color: { light: "#fff" }, content: "Beta" },
      }).success
    ).toBe(false);
    expect(
      blumeConfigSchema.safeParse({
        banner: { content: "Beta", type: "warning" },
      }).success
    ).toBe(false);
  });
});

describe("navigation.featured", () => {
  it("defaults to an empty list", () => {
    expect(blumeConfigSchema.parse({}).navigation.featured).toStrictEqual([]);
  });

  it("parses pinned links with an optional icon", () => {
    const config = blumeConfigSchema.parse({
      navigation: {
        featured: [
          {
            href: "https://blog.example.com",
            icon: "newspaper",
            label: "Blog",
          },
          { href: "/contact", label: "Contact" },
        ],
      },
    });
    expect(config.navigation.featured).toStrictEqual([
      { href: "https://blog.example.com", icon: "newspaper", label: "Blog" },
      { href: "/contact", label: "Contact" },
    ]);
  });

  it("rejects a featured link missing href or label, or with extra keys", () => {
    expect(
      blumeConfigSchema.safeParse({
        navigation: { featured: [{ label: "No href" }] },
      }).success
    ).toBe(false);
    expect(
      blumeConfigSchema.safeParse({
        navigation: {
          featured: [{ href: "/x", label: "X", target: "_blank" }],
        },
      }).success
    ).toBe(false);
  });
});

describe("pruned Mintlify-compat config fields", () => {
  it("rejects config fields that were removed", () => {
    for (const field of [
      "navbar",
      "footer",
      "contextual",
      "styling",
      "favicon",
      "icons",
      "variables",
    ]) {
      expect(
        blumeConfigSchema.safeParse({ [field]: {} }).success,
        `${field} should no longer be a valid config field`
      ).toBe(false);
    }
  });

  it("rejects removed nested config fields", () => {
    const cases: Record<string, unknown> = {
      navigation: { chromeVariants: [] },
      search: { prompt: "Ask" },
      seo: { metatags: {} },
      theme: { backgroundDecoration: "grid" },
    };
    for (const [field, value] of Object.entries(cases)) {
      expect(
        blumeConfigSchema.safeParse({ [field]: value }).success,
        `${field} nested compat field should be rejected`
      ).toBe(false);
    }
  });
});

describe("pruned Mintlify-compat frontmatter keys", () => {
  it("rejects frontmatter keys that were removed", () => {
    for (const key of [
      "sidebarTitle",
      "tag",
      "mode",
      "public",
      "rss",
      "hideApiMarker",
      "hideFooterPagination",
      "groups",
      "keywords",
      "iconType",
    ]) {
      expect(
        pageMetaSchema.safeParse({ [key]: "x" }).success,
        `${key} should no longer be a valid frontmatter key`
      ).toBe(false);
    }
  });
});

describe("export config normalization", () => {
  it("expands the boolean shorthand to both formats", () => {
    expect(blumeConfigSchema.parse({ export: true }).export).toStrictEqual({
      epub: true,
      pdf: true,
    });
  });

  it("keeps an object form with per-format toggles", () => {
    expect(
      blumeConfigSchema.parse({ export: { epub: true } }).export
    ).toStrictEqual({ epub: true, pdf: false });
  });
});

describe("examples config normalization", () => {
  it("defaults to the examples directory with no css", () => {
    expect(blumeConfigSchema.parse({}).examples).toStrictEqual({
      source: "examples",
    });
  });

  it("expands the string shorthand to { source }", () => {
    expect(
      blumeConfigSchema.parse({ examples: "registry/**/examples/*" }).examples
    ).toStrictEqual({ source: "registry/**/examples/*" });
  });

  it("keeps the object form and defaults source", () => {
    expect(
      blumeConfigSchema.parse({ examples: { css: "examples/theme.css" } })
        .examples
    ).toStrictEqual({ css: "examples/theme.css", source: "examples" });
  });
});

describe("analytics script refinement", () => {
  it("accepts a script that sets exactly one of src or content", () => {
    const config = blumeConfigSchema.parse({
      analytics: { scripts: [{ src: "https://x.test/a.js" }] },
    });
    expect(config.analytics?.scripts?.[0]?.src).toBe("https://x.test/a.js");
  });

  it("rejects a script that sets both src and content", () => {
    expect(
      blumeConfigSchema.safeParse({
        analytics: { scripts: [{ content: "x", src: "https://x.test/a.js" }] },
      }).success
    ).toBeFalsy();
  });
});
