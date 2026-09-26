import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { metatagAttributes, ownedMetatag } from "../src/seo/metatags.ts";

/**
 * Site-wide meta tags (`seo.metatags`): the tags a site adds to every page,
 * refused where Blume writes the tag itself, and rendered with `property`
 * for the Open Graph families.
 */

describe(ownedMetatag, () => {
  it("names the setting behind each tag Blume writes", () => {
    expect(ownedMetatag("description")).toContain("`description`");
    expect(ownedMetatag(" Robots ")).toBe(
      "`seo.noindex` in a page's frontmatter"
    );
    expect(ownedMetatag("og:image")).toContain("`seo.og`");
    expect(ownedMetatag("og:image:width")).toContain("`seo.og`");
    expect(ownedMetatag("twitter:image:alt")).toContain("`seo.og`");
    expect(ownedMetatag("twitter:site")).toBe("`seo.x.handle`");
  });

  it("leaves every other tag to the site", () => {
    for (const name of [
      "google-site-verification",
      "theme-color",
      "og:locale",
      "fb:app_id",
      "og:imagery",
    ]) {
      expect(ownedMetatag(name)).toBeUndefined();
    }
  });
});

describe(metatagAttributes, () => {
  it("names Open Graph families with property and the rest with name", () => {
    expect(
      metatagAttributes({
        "OG:locale": "en_US",
        "article:author": "Jane",
        "fb:app_id": "123",
        "google-site-verification": "abc",
      })
    ).toStrictEqual([
      { content: "en_US", property: "OG:locale" },
      { content: "Jane", property: "article:author" },
      { content: "123", property: "fb:app_id" },
      { content: "abc", name: "google-site-verification" },
    ]);
    expect(metatagAttributes(null)).toStrictEqual([]);
    expect(metatagAttributes()).toStrictEqual([]);
  });
});

describe("seo.metatags", () => {
  it("takes the site's own tags", () => {
    const tags = { "google-site-verification": "abc", "theme-color": "#000" };
    expect(
      blumeConfigSchema.parse({ seo: { metatags: tags } }).seo.metatags
    ).toStrictEqual(tags);
    expect(blumeConfigSchema.parse({}).seo.metatags).toBeUndefined();
  });

  it("refuses a tag Blume writes, pointing at the setting for it", () => {
    const result = blumeConfigSchema.safeParse({
      seo: { metatags: { "og:image": "/card.png", "theme-color": "#000" } },
    });
    expect(result.error?.issues).toMatchObject([
      {
        message:
          "seo.metatags can't set \"og:image\": Blume writes that tag. Set it with `seo.og` for the generated cards, or `seo.image` in a page's frontmatter.",
        path: ["seo", "metatags", "og:image"],
      },
    ]);
  });
});
