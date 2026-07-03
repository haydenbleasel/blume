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

describe("banner color refinement", () => {
  it("accepts a banner color with a single side set", () => {
    const config = blumeConfigSchema.parse({
      banner: { color: { light: "#fff" }, content: "Beta" },
    });
    expect(config.banner).toStrictEqual({
      color: { light: "#fff" },
      content: "Beta",
      dismissible: false,
    });
  });

  it("rejects a banner color with neither side set", () => {
    expect(
      blumeConfigSchema.safeParse({
        banner: { color: {}, content: "Beta" },
      }).success
    ).toBeFalsy();
  });
});

describe("pruned Mintlify-compat fields", () => {
  it("rejects config fields that were removed (navbar/footer/etc.)", () => {
    for (const field of ["navbar", "footer", "contextual", "styling"]) {
      expect(
        blumeConfigSchema.safeParse({ [field]: {} }).success,
        `${field} should no longer be a valid config field`
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
