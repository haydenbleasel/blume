import { describe, expect, it } from "bun:test";

import { assetChecks } from "../src/audit/checks/assets.ts";
import { contentChecks } from "../src/audit/checks/content.ts";
import { duplicateChecks } from "../src/audit/checks/duplicates.ts";
import { i18nChecks } from "../src/audit/checks/i18n.ts";
import { indexabilityChecks } from "../src/audit/checks/indexability.ts";
import { linkChecks } from "../src/audit/checks/links.ts";
import { redirectChecks } from "../src/audit/checks/redirects.ts";
import { disallowMatches, robotsChecks } from "../src/audit/checks/robots.ts";
import { sitemapChecks } from "../src/audit/checks/sitemap.ts";
import {
  socialChecks,
  structuredDataChecks,
  urlChecks,
} from "../src/audit/checks/social.ts";
import type { AuditContext, CheckModule } from "../src/audit/types.ts";
import type { Diagnostic } from "../src/core/types.ts";
import { codes, context, snapshot } from "./audit-support.ts";

/**
 * Every check, exercised against the smallest page that triggers it.
 *
 * The `silent` half of each case is the half that matters. A check that fires on
 * a healthy page is worse than no check at all — it trains people to ignore the
 * report — so the whole audit is only as trustworthy as its false-positive rate.
 */

// Every static check is synchronous; only the network tiers return a promise.
const run = (module: CheckModule, ctx: AuditContext): string[] =>
  codes(module.run(ctx) as Diagnostic[]);

const SITE = "https://x.dev";

describe("content checks", () => {
  it("is silent on a healthy page", () => {
    expect(run(contentChecks, context())).toEqual([]);
  });

  it("reports a missing title", () => {
    const ctx = context({ pages: [snapshot({ titles: [] })] });
    expect(run(contentChecks, ctx)).toContain("TITLE_MISSING");
  });

  it("reports multiple titles", () => {
    const ctx = context({ pages: [snapshot({ titles: ["One", "Two"] })] });
    expect(run(contentChecks, ctx)).toContain("TITLE_MULTIPLE");
  });

  it("reports a title that is too long", () => {
    const ctx = context({ pages: [snapshot({ titles: ["x".repeat(80)] })] });
    expect(run(contentChecks, ctx)).toContain("TITLE_LENGTH");
  });

  it("reports a title that is too short", () => {
    const ctx = context({ pages: [snapshot({ titles: ["Hi"] })] });
    expect(run(contentChecks, ctx)).toContain("TITLE_LENGTH");
  });

  it("reports a missing description", () => {
    const ctx = context({ pages: [snapshot({ descriptions: [] })] });
    expect(run(contentChecks, ctx)).toContain("DESCRIPTION_MISSING");
  });

  it("reports multiple descriptions", () => {
    const ctx = context({
      pages: [
        snapshot({
          descriptions: ["A description long enough to pass the check.", "Two"],
        }),
      ],
    });
    expect(run(contentChecks, ctx)).toContain("DESCRIPTION_MULTIPLE");
  });

  it("reports a description that is too long", () => {
    const ctx = context({
      pages: [snapshot({ descriptions: ["x".repeat(200)] })],
    });
    expect(run(contentChecks, ctx)).toContain("DESCRIPTION_LENGTH");
  });

  it("reports a missing h1", () => {
    const ctx = context({ pages: [snapshot({ headings: [] })] });
    expect(run(contentChecks, ctx)).toContain("H1_MISSING");
  });

  it("reports multiple h1s", () => {
    const ctx = context({
      pages: [
        snapshot({
          headings: [
            { depth: 1, text: "One" },
            { depth: 1, text: "Two" },
          ],
        }),
      ],
    });
    expect(run(contentChecks, ctx)).toContain("H1_MULTIPLE");
  });

  it("reports a low word count, but only on an indexable page", () => {
    expect(
      run(contentChecks, context({ pages: [snapshot({ wordCount: 3 })] }))
    ).toContain("LOW_WORD_COUNT");
    const hidden = context({
      pages: [snapshot({ indexable: false, wordCount: 3 })],
    });
    expect(run(contentChecks, hidden)).not.toContain("LOW_WORD_COUNT");
  });

  it("reports a missing viewport", () => {
    const ctx = context({ pages: [snapshot({ viewport: null })] });
    expect(run(contentChecks, ctx)).toContain("VIEWPORT_MISSING");
  });
});

const twin = (extra: Parameters<typeof snapshot>[0] = {}) => [
  snapshot({ url: "/a", ...extra }),
  snapshot({ url: "/b", ...extra }),
];

describe("duplicate checks", () => {
  it("is silent when pages differ", () => {
    const ctx = context({
      pages: [
        snapshot({ contentHash: "a", titles: ["Alpha page"], url: "/a" }),
        snapshot({
          contentHash: "b",
          descriptions: ["A different description, also long enough."],
          titles: ["Beta page"],
          url: "/b",
        }),
      ],
    });
    expect(run(duplicateChecks, ctx)).toEqual([]);
  });

  it("reports duplicate titles, descriptions, and content", () => {
    const found = run(duplicateChecks, context({ pages: twin() }));
    expect(found).toContain("DUPLICATE_TITLE");
    expect(found).toContain("DUPLICATE_DESCRIPTION");
    expect(found).toContain("DUPLICATE_CONTENT");
  });

  it("ignores a fallback page, which is a copy by design", () => {
    // An i18n fallback renders the default locale's content at a localized URL.
    // Treating that as duplication would flag every untranslated page.
    const ctx = context({
      pages: [
        snapshot({ url: "/a" }),
        snapshot({
          route: { fallback: true } as never,
          url: "/fr/a",
        }),
      ],
    });
    expect(run(duplicateChecks, ctx)).toEqual([]);
  });

  it("ignores a page that canonicalizes elsewhere", () => {
    const ctx = context({
      pages: [
        snapshot({ url: "/a" }),
        snapshot({ canonical: `${SITE}/a`, url: "/b" }),
      ],
    });
    expect(run(duplicateChecks, ctx)).toEqual([]);
  });

  it("does not treat two empty pages as duplicate content", () => {
    const ctx = context({
      pages: [
        snapshot({ contentHash: "e", url: "/a", wordCount: 0 }),
        snapshot({ contentHash: "e", url: "/b", wordCount: 0 }),
      ],
    });
    expect(run(duplicateChecks, ctx)).not.toContain("DUPLICATE_CONTENT");
  });
});

describe("indexability checks", () => {
  it("reports an unset deployment.site exactly once, not once per page", () => {
    const ctx = context({
      pages: [snapshot({ url: "/a" }), snapshot({ url: "/b" })],
    });
    const found = run(indexabilityChecks, ctx);
    expect(found.filter((code) => code === "SITE_NOT_SET")).toHaveLength(1);
    // With no site there is no absolute URL to canonicalize to, so a missing
    // canonical is not a per-page defect.
    expect(found).not.toContain("CANONICAL_MISSING");
  });

  it("does not tell a platform-adapter project to set deployment.site", () => {
    // On Vercel/Netlify/Cloudflare the site arrives from platform env vars at
    // deploy time, so only the local artifact is missing it. Suggesting a
    // hardcoded `deployment.site` here would have `--claude`/`--codex` (which
    // apply suggestions verbatim) duplicate state the platform owns.
    const ctx = context({ adapter: "vercel" });
    const found = indexabilityChecks.run(ctx) as Diagnostic[];
    const ids = found.map((d) => d.code);
    expect(ids).toContain("BLUME_AUDIT_SITE_INFERRED_AT_DEPLOY");
    expect(ids).not.toContain("BLUME_AUDIT_SITE_NOT_SET");

    const inferred = found.find(
      (d) => d.code === "BLUME_AUDIT_SITE_INFERRED_AT_DEPLOY"
    );
    expect(inferred?.severity).toBe("info");
    expect(inferred?.message).toContain("vercel");
    expect(inferred?.suggestion).toContain("Do not hardcode");
  });

  it("still tells an adapterless project to set deployment.site", () => {
    // With no platform to infer it from, setting it explicitly is the fix.
    const ctx = context({ adapter: "node" });
    expect(run(indexabilityChecks, ctx)).toContain("SITE_NOT_SET");
  });

  it("reports a missing canonical once a site is configured", () => {
    const ctx = context({ pages: [snapshot({ canonical: null })], site: SITE });
    expect(run(indexabilityChecks, ctx)).toContain("CANONICAL_MISSING");
  });

  it("is silent on a self-canonical page", () => {
    const ctx = context({
      pages: [snapshot({ canonical: `${SITE}/`, url: "/" })],
      site: SITE,
    });
    expect(run(indexabilityChecks, ctx)).toEqual([]);
  });

  it("reports a canonical pointing at a page that does not exist", () => {
    const ctx = context({
      pages: [snapshot({ canonical: `${SITE}/nope`, url: "/" })],
      site: SITE,
    });
    expect(run(indexabilityChecks, ctx)).toContain("CANONICAL_BAD_TARGET");
  });

  it("reports a canonical pointing at a redirect", () => {
    const ctx = context({
      pages: [snapshot({ canonical: `${SITE}/old`, url: "/" })],
      redirects: [{ from: "/old", status: 301, to: "/" }],
      site: SITE,
    });
    expect(run(indexabilityChecks, ctx)).toContain("CANONICAL_BAD_TARGET");
  });

  it("reports a malformed canonical", () => {
    const ctx = context({
      pages: [snapshot({ canonical: "not a url" })],
      site: SITE,
    });
    expect(run(indexabilityChecks, ctx)).toContain("CANONICAL_BAD_TARGET");
  });

  it("reports a canonical on the wrong protocol", () => {
    const ctx = context({
      pages: [snapshot({ canonical: "http://x.dev/", url: "/" })],
      site: SITE,
    });
    expect(run(indexabilityChecks, ctx)).toContain(
      "CANONICAL_PROTOCOL_MISMATCH"
    );
  });

  it("accepts a deliberate cross-site canonical", () => {
    const ctx = context({
      pages: [snapshot({ canonical: "https://other.dev/x", url: "/" })],
      site: SITE,
    });
    expect(run(indexabilityChecks, ctx)).toEqual([]);
  });

  it("reports a page that canonicalizes to another page on the site", () => {
    const ctx = context({
      pages: [
        snapshot({ canonical: `${SITE}/a`, url: "/b" }),
        snapshot({ canonical: `${SITE}/a`, url: "/a" }),
      ],
      site: SITE,
    });
    expect(run(indexabilityChecks, ctx)).toContain("CANONICAL_NOT_SELF");
  });

  it("reports a noindex page but not a 404", () => {
    const noindex = context({
      pages: [snapshot({ robots: "noindex", url: "/secret" })],
    });
    expect(run(indexabilityChecks, noindex)).toContain(
      "ROBOTS_META_UNEXPECTED"
    );
    // A 404 is *meant* to be noindex, so flagging it would fire on every site.
    const error = context({
      pages: [snapshot({ robots: "noindex", url: "/404" })],
    });
    expect(run(indexabilityChecks, error)).not.toContain(
      "ROBOTS_META_UNEXPECTED"
    );
  });

  it("reports HTML past Googlebot's 2 MB limit", () => {
    const ctx = context({ pages: [snapshot({ bytes: 3 * 1024 * 1024 })] });
    expect(run(indexabilityChecks, ctx)).toContain("HTML_TOO_LARGE");
  });
});

const link = (href: string, content = true, rel: string | null = null) => ({
  content,
  href,
  rel,
  text: "x",
});

describe("link checks", () => {
  it("is silent on a link to a real page", () => {
    const ctx = context({
      pages: [
        snapshot({ links: [link("/b")], url: "/a" }),
        snapshot({ links: [link("/a")], url: "/b" }),
      ],
    });
    expect(run(linkChecks, ctx)).toEqual([]);
  });

  it("reports a body link to a page that does not exist", () => {
    const ctx = context({
      pages: [snapshot({ links: [link("/nope")], url: "/a" })],
    });
    expect(run(linkChecks, ctx)).toContain("LINK_TO_BROKEN");
  });

  it("reports a broken nav link once, not once per page", () => {
    // Blume renders the sidebar on every page. Without deduplication one bad
    // nav entry becomes one finding per page — hundreds, for a single typo.
    const pages = Array.from({ length: 5 }, (_, index) =>
      snapshot({ links: [link("/nope", false)], url: `/p${index}` })
    );
    const found = run(linkChecks, context({ pages }));
    expect(found.filter((code) => code === "LINK_TO_BROKEN")).toHaveLength(1);
  });

  it("reports a link to a redirect", () => {
    const ctx = context({
      pages: [snapshot({ links: [link("/old")], url: "/a" })],
      redirects: [{ from: "/old", status: 301, to: "/a" }],
    });
    expect(run(linkChecks, ctx)).toContain("LINK_TO_REDIRECT");
  });

  it("reports a nav link to a redirect once", () => {
    const pages = Array.from({ length: 3 }, (_, index) =>
      snapshot({ links: [link("/old", false)], url: `/p${index}` })
    );
    const ctx = context({
      pages,
      redirects: [{ from: "/old", status: 301, to: "/p0" }],
    });
    expect(
      run(linkChecks, ctx).filter((code) => code === "LINK_TO_REDIRECT")
    ).toHaveLength(1);
  });

  it("accepts a link to a static file", () => {
    const ctx = context({
      files: new Map([["/paper.pdf", 100]]),
      pages: [snapshot({ links: [link("/paper.pdf")], url: "/" })],
    });
    expect(run(linkChecks, ctx)).toEqual([]);
  });

  it("reports an internal link that hardcodes the site origin", () => {
    const ctx = context({
      pages: [snapshot({ links: [link(`${SITE}/a`)], url: "/a" })],
      site: SITE,
    });
    expect(run(linkChecks, ctx)).toContain("INTERNAL_LINK_ABSOLUTE");
  });

  it("ignores a genuine external link", () => {
    const ctx = context({
      pages: [snapshot({ links: [link("https://other.dev/x")], url: "/" })],
      site: SITE,
    });
    expect(run(linkChecks, ctx)).toEqual([]);
  });

  it("reports a nofollow internal link", () => {
    const ctx = context({
      pages: [snapshot({ links: [link("/", true, "nofollow")], url: "/" })],
    });
    expect(run(linkChecks, ctx)).toContain("INTERNAL_LINK_NOFOLLOW");
  });

  it("reports a page linked only from the sidebar as an orphan", () => {
    // The check exists precisely because Blume links every page from the
    // sidebar: a naive graph would find zero orphans, forever.
    const ctx = context({
      pages: [
        snapshot({ links: [link("/lonely", false)], url: "/" }),
        snapshot({ links: [], url: "/lonely" }),
      ],
    });
    expect(run(linkChecks, ctx)).toContain("ORPHAN_PAGE");
  });

  it("does not report a page linked from another page's body", () => {
    const ctx = context({
      pages: [
        snapshot({ links: [link("/found", true)], url: "/" }),
        snapshot({ links: [], url: "/found" }),
      ],
    });
    expect(run(linkChecks, ctx)).not.toContain("ORPHAN_PAGE");
  });
});

describe("redirect checks", () => {
  it("is silent on a redirect straight to a real page", () => {
    const ctx = context({
      pages: [snapshot({ url: "/new" })],
      redirects: [{ from: "/old", status: 301, to: "/new" }],
    });
    expect(run(redirectChecks, ctx)).toEqual([]);
  });

  it("reports a redirect to nowhere", () => {
    const ctx = context({
      redirects: [{ from: "/old", status: 301, to: "/gone" }],
    });
    expect(run(redirectChecks, ctx)).toContain("REDIRECT_BROKEN");
  });

  it("reports a redirect loop", () => {
    const ctx = context({
      redirects: [
        { from: "/a", status: 301, to: "/b" },
        { from: "/b", status: 301, to: "/a" },
      ],
    });
    expect(run(redirectChecks, ctx)).toContain("REDIRECT_LOOP");
  });

  it("reports a redirect chain", () => {
    const ctx = context({
      pages: [snapshot({ url: "/c" })],
      redirects: [
        { from: "/a", status: 301, to: "/b" },
        { from: "/b", status: 301, to: "/c" },
      ],
    });
    expect(run(redirectChecks, ctx)).toContain("REDIRECT_CHAIN");
  });

  it("accepts an external redirect target", () => {
    const ctx = context({
      redirects: [{ from: "/x", status: 301, to: "https://other.dev/x" }],
    });
    expect(run(redirectChecks, ctx)).toEqual([]);
  });

  it("reports a redirect shadowed by a real page", () => {
    // The page wins, so the redirect never fires. A live crawler cannot see
    // this: the served response looks perfectly healthy.
    const ctx = context({
      pages: [snapshot({ url: "/both" })],
      redirects: [{ from: "/both", status: 301, to: "/" }],
    });
    expect(run(redirectChecks, ctx)).toContain("REDIRECT_SOURCE_IS_PAGE");
  });

  it("reports a meta refresh", () => {
    const ctx = context({ pages: [snapshot({ metaRefresh: "0; url=/x" })] });
    expect(run(redirectChecks, ctx)).toContain("META_REFRESH");
  });
});

describe("social checks", () => {
  it("is silent on a fully tagged page", () => {
    expect(run(socialChecks, context({ site: SITE }))).toEqual([]);
  });

  it("reports missing Open Graph tags", () => {
    const ctx = context({ pages: [snapshot({ og: {} })] });
    expect(run(socialChecks, ctx)).toContain("OG_INCOMPLETE");
  });

  it("does not demand og:url or og:image when no site is configured", () => {
    // Both need an absolute URL, which Blume cannot build without
    // `deployment.site`. SITE_NOT_SET reports that once.
    const ctx = context({
      pages: [
        snapshot({
          og: { "og:description": "d", "og:title": "t", "og:type": "website" },
        }),
      ],
    });
    expect(run(socialChecks, ctx)).toEqual([]);
  });

  it("reports a missing og:image once a site is configured", () => {
    const ctx = context({
      pages: [
        snapshot({
          og: {
            "og:description": "d",
            "og:title": "t",
            "og:type": "website",
            "og:url": `${SITE}/`,
          },
        }),
      ],
      site: SITE,
    });
    expect(run(socialChecks, ctx)).toContain("OG_IMAGE_MISSING");
  });

  it("reports an og:url that disagrees with the canonical", () => {
    const ctx = context({
      pages: [
        snapshot({ canonical: `${SITE}/real`, og: { ...snapshot().og } }),
      ],
      site: SITE,
    });
    expect(run(socialChecks, ctx)).toContain("OG_URL_MISMATCH");
  });

  it("reports a missing X card", () => {
    const ctx = context({ pages: [snapshot({ twitter: {} })], site: SITE });
    expect(run(socialChecks, ctx)).toContain("TWITTER_CARD_INCOMPLETE");
  });

  it("skips non-indexable pages, which are never shared", () => {
    const ctx = context({
      pages: [snapshot({ indexable: false, og: {}, twitter: {} })],
      site: SITE,
    });
    expect(run(socialChecks, ctx)).toEqual([]);
  });
});

describe("structured data checks", () => {
  it("accepts the @graph shape Blume emits", () => {
    // `@context` sits on the root and `@type` on each node. Demanding both on
    // the root would flag every page on every Blume site.
    const ctx = context({
      pages: [
        snapshot({
          jsonld: [
            {
              "@context": "https://schema.org",
              "@graph": [{ "@type": "TechArticle", name: "x" }],
            },
          ],
        }),
      ],
    });
    expect(run(structuredDataChecks, ctx)).toEqual([]);
  });

  it("accepts a single typed node", () => {
    const ctx = context({
      pages: [
        snapshot({
          jsonld: [{ "@context": "https://schema.org", "@type": "WebSite" }],
        }),
      ],
    });
    expect(run(structuredDataChecks, ctx)).toEqual([]);
  });

  it("reports unparseable JSON-LD", () => {
    const ctx = context({
      pages: [snapshot({ jsonldErrors: ["Unexpected token"] })],
    });
    expect(run(structuredDataChecks, ctx)).toContain("JSONLD_INVALID");
  });

  it("reports a node with no @context or @type", () => {
    const ctx = context({ pages: [snapshot({ jsonld: [{ name: "x" }] })] });
    expect(run(structuredDataChecks, ctx)).toContain("JSONLD_INCOMPLETE");
  });

  it("reports an untyped node inside a @graph", () => {
    const ctx = context({
      pages: [
        snapshot({
          jsonld: [
            { "@context": "https://schema.org", "@graph": [{ name: "x" }] },
          ],
        }),
      ],
    });
    expect(run(structuredDataChecks, ctx)).toContain("JSONLD_INCOMPLETE");
  });

  it("reports a JSON-LD block that is not an object", () => {
    const ctx = context({ pages: [snapshot({ jsonld: ["nope"] })] });
    expect(run(structuredDataChecks, ctx)).toContain("JSONLD_INCOMPLETE");
  });
});

describe("url checks", () => {
  it("reports a double slash in a URL", () => {
    const ctx = context({ pages: [snapshot({ url: "//docs/x" })] });
    expect(run(urlChecks, ctx)).toContain("DOUBLE_SLASH_URL");
  });

  it("is silent on a normal URL", () => {
    expect(run(urlChecks, context())).toEqual([]);
  });
});

const image = (partial = {}) => ({
  alt: "A picture",
  height: "100",
  src: "/img.png",
  width: "100",
  ...partial,
});
const files = new Map([
  ["/img.png", 1000],
  ["/app.js", 1000],
  ["/app.css", 1000],
]);

describe("asset checks", () => {
  it("is silent on a well-formed image", () => {
    const ctx = context({ files, pages: [snapshot({ images: [image()] })] });
    expect(run(assetChecks, ctx)).toEqual([]);
  });

  it("reports a missing alt attribute but accepts a decorative one", () => {
    const missing = context({
      files,
      pages: [snapshot({ images: [image({ alt: null })] })],
    });
    expect(run(assetChecks, missing)).toContain("IMAGE_ALT_MISSING");
    // `alt=""` is a deliberate "this image is decorative", and is correct.
    const decorative = context({
      files,
      pages: [snapshot({ images: [image({ alt: "" })] })],
    });
    expect(run(assetChecks, decorative)).not.toContain("IMAGE_ALT_MISSING");
  });

  it("reports an image that is not in the build", () => {
    const ctx = context({
      files,
      pages: [snapshot({ images: [image({ src: "/gone.png" })] })],
    });
    expect(run(assetChecks, ctx)).toContain("IMAGE_BROKEN");
  });

  it("reports an image with no dimensions", () => {
    const ctx = context({
      files,
      pages: [snapshot({ images: [image({ height: null, width: null })] })],
    });
    expect(run(assetChecks, ctx)).toContain("IMAGE_MISSING_DIMENSIONS");
  });

  it("reports an oversized asset", () => {
    const ctx = context({
      files: new Map([["/img.png", 5 * 1024 * 1024]]),
      pages: [snapshot({ images: [image()] })],
    });
    expect(run(assetChecks, ctx)).toContain("ASSET_TOO_LARGE");
  });

  it("reports a missing script or stylesheet", () => {
    const ctx = context({
      files,
      pages: [
        snapshot({
          scripts: [{ src: "/gone.js" }],
          styles: [{ src: "/gone.css" }],
        }),
      ],
    });
    expect(
      run(assetChecks, ctx).filter((code) => code === "SUBRESOURCE_MISSING")
    ).toHaveLength(2);
  });

  it("reports a subresource loaded over plain HTTP", () => {
    const ctx = context({
      files,
      pages: [snapshot({ scripts: [{ src: "http://cdn.dev/a.js" }] })],
    });
    expect(run(assetChecks, ctx)).toContain("MIXED_CONTENT");
  });

  it("ignores a data URI and a cross-origin subresource", () => {
    const ctx = context({
      files,
      pages: [
        snapshot({
          images: [image({ src: "data:image/png;base64,AAA" })],
          scripts: [{ src: "https://cdn.dev/a.js" }],
        }),
      ],
      site: SITE,
    });
    expect(run(assetChecks, ctx)).toEqual([]);
  });
});

const sitemapDoc = (urls: string[], extra = {}) => ({
  bytes: 500,
  file: "/dist/sitemap.xml",
  urls,
  ...extra,
});

describe("sitemap checks", () => {
  const doc = sitemapDoc;
  it("stays quiet when no site is configured", () => {
    expect(run(sitemapChecks, context())).toEqual([]);
  });

  it("reports a build with no sitemap", () => {
    const ctx = context({ site: SITE });
    expect(run(sitemapChecks, ctx)).toContain("SITEMAP_INVALID");
  });

  it("is silent when the sitemap matches the build", () => {
    const ctx = context({
      pages: [snapshot({ url: "/" })],
      site: SITE,
      sitemap: doc([`${SITE}/`]),
    });
    expect(run(sitemapChecks, ctx)).toEqual([]);
  });

  it("reports a malformed sitemap", () => {
    const ctx = context({
      site: SITE,
      sitemap: doc([], { error: "no <urlset> element" }),
    });
    expect(run(sitemapChecks, ctx)).toContain("SITEMAP_INVALID");
  });

  it("reports a sitemap over the size limits", () => {
    const ctx = context({
      pages: [snapshot({ url: "/" })],
      site: SITE,
      sitemap: doc([`${SITE}/`], { bytes: 60 * 1024 * 1024 }),
    });
    expect(run(sitemapChecks, ctx)).toContain("SITEMAP_TOO_LARGE");
  });

  it("reports a URL on another origin", () => {
    const ctx = context({
      pages: [snapshot({ url: "/" })],
      site: SITE,
      sitemap: doc([`${SITE}/`, "https://other.dev/x"]),
    });
    expect(run(sitemapChecks, ctx)).toContain("SITEMAP_OUT_OF_SCOPE");
  });

  it("reports a listed URL that the build does not serve", () => {
    const ctx = context({
      pages: [snapshot({ url: "/" })],
      site: SITE,
      sitemap: doc([`${SITE}/`, `${SITE}/gone`]),
    });
    expect(run(sitemapChecks, ctx)).toContain("SITEMAP_BAD_URL");
  });

  it("reports a listed URL that redirects instead of serving a page", () => {
    const ctx = context({
      pages: [snapshot({ url: "/" })],
      redirects: [{ from: "/moved", status: 301, to: "/" }],
      site: SITE,
      sitemap: doc([`${SITE}/`, `${SITE}/moved`]),
    });
    expect(run(sitemapChecks, ctx)).toContain("SITEMAP_BAD_URL");
  });

  it("reports a listed URL that is not a valid absolute URL", () => {
    const ctx = context({
      pages: [snapshot({ url: "/" })],
      site: SITE,
      sitemap: doc([`${SITE}/`, "///"]),
    });
    expect(run(sitemapChecks, ctx)).toContain("SITEMAP_INVALID");
  });

  it("reports a noindex page in the sitemap", () => {
    const ctx = context({
      pages: [snapshot({ indexable: false, robots: "noindex", url: "/" })],
      site: SITE,
      sitemap: doc([`${SITE}/`]),
    });
    expect(run(sitemapChecks, ctx)).toContain("NOINDEX_IN_SITEMAP");
  });

  it("reports a non-canonical page in the sitemap", () => {
    const ctx = context({
      pages: [snapshot({ canonical: `${SITE}/other`, url: "/" })],
      site: SITE,
      sitemap: doc([`${SITE}/`]),
    });
    expect(run(sitemapChecks, ctx)).toContain("NON_CANONICAL_IN_SITEMAP");
  });

  it("reports an indexable page missing from the sitemap", () => {
    // The highest-value check here: a stray `draft` or `hidden` silently keeps a
    // page out of the sitemap, and nothing else in the toolchain says so.
    const ctx = context({
      pages: [snapshot({ url: "/" }), snapshot({ url: "/forgotten" })],
      site: SITE,
      sitemap: doc([`${SITE}/`]),
    });
    expect(run(sitemapChecks, ctx)).toContain("INDEXABLE_PAGE_NOT_IN_SITEMAP");
  });

  it("does not expect error routes in the sitemap", () => {
    const ctx = context({
      pages: [snapshot({ url: "/" }), snapshot({ url: "/404" })],
      site: SITE,
      sitemap: doc([`${SITE}/`]),
    });
    expect(run(sitemapChecks, ctx)).not.toContain(
      "INDEXABLE_PAGE_NOT_IN_SITEMAP"
    );
  });
});

const robotsDoc = (extra = {}) => ({
  disallow: [],
  file: "/dist/robots.txt",
  invalid: [],
  sitemaps: [`${SITE}/sitemap.xml`],
  ...extra,
});

describe("robots checks", () => {
  const doc = robotsDoc;
  it("stays quiet when robots generation is off", () => {
    const ctx = context({ seo: { robots: false } });
    expect(run(robotsChecks, ctx)).toEqual([]);
  });

  it("reports a build with no robots.txt", () => {
    expect(run(robotsChecks, context())).toContain("ROBOTS_MISSING");
  });

  it("is silent on a healthy robots.txt", () => {
    const ctx = context({ robots: doc(), site: SITE });
    expect(run(robotsChecks, ctx)).toEqual([]);
  });

  it("reports a syntax error", () => {
    const ctx = context({
      robots: doc({ invalid: [{ line: 3, text: "garbage" }] }),
      site: SITE,
    });
    expect(run(robotsChecks, ctx)).toContain("ROBOTS_INVALID");
  });

  it("reports a robots.txt with no sitemap reference", () => {
    const ctx = context({ robots: doc({ sitemaps: [] }), site: SITE });
    expect(run(robotsChecks, ctx)).toContain("ROBOTS_SITEMAP_MISSING");
  });

  it("reports a rule that blocks a page the sitemap advertises", () => {
    const ctx = context({
      pages: [snapshot({ url: "/docs/x" })],
      robots: doc({ disallow: ["/docs/"] }),
      site: SITE,
      sitemap: {
        bytes: 100,
        file: "/dist/sitemap.xml",
        urls: [`${SITE}/docs/x`],
      },
    });
    expect(run(robotsChecks, ctx)).toContain("ROBOTS_DISALLOWS_INDEXABLE");
  });
});

describe("disallowMatches", () => {
  it("matches a prefix", () => {
    expect(disallowMatches("/docs", "/docs/x")).toBe(true);
    expect(disallowMatches("/api", "/docs/x")).toBe(false);
  });

  it("honors a wildcard", () => {
    expect(disallowMatches("/*/private", "/a/private")).toBe(true);
    expect(disallowMatches("/*/private", "/a/public")).toBe(false);
  });

  it("honors an end anchor", () => {
    expect(disallowMatches("/docs$", "/docs")).toBe(true);
    expect(disallowMatches("/docs$", "/docs/x")).toBe(false);
  });
});

const pair = () => [
  snapshot({
    hreflang: [
      { href: `${SITE}/`, lang: "en" },
      { href: `${SITE}/fr`, lang: "fr" },
      { href: `${SITE}/`, lang: "x-default" },
    ],
    url: "/",
  }),
  snapshot({
    hreflang: [
      { href: `${SITE}/`, lang: "en" },
      { href: `${SITE}/fr`, lang: "fr" },
      { href: `${SITE}/`, lang: "x-default" },
    ],
    lang: "fr",
    url: "/fr",
  }),
];

describe("i18n checks", () => {
  it("reports a missing lang attribute", () => {
    const ctx = context({ pages: [snapshot({ lang: null })] });
    expect(run(i18nChecks, ctx)).toContain("HTML_LANG_MISSING");
  });

  it("reports an invalid lang attribute", () => {
    const ctx = context({ pages: [snapshot({ lang: "not a locale" })] });
    expect(run(i18nChecks, ctx)).toContain("HTML_LANG_INVALID");
  });

  it("runs no hreflang checks on a monolingual site", () => {
    // The hreflang cluster is gated on the page carrying hreflang tags, so a
    // site with no translations sees none of it — no wall of no-ops.
    expect(run(i18nChecks, context())).toEqual([]);
  });

  it("is silent on a well-formed hreflang cluster", () => {
    expect(run(i18nChecks, context({ pages: pair(), site: SITE }))).toEqual([]);
  });

  it("reports an invalid hreflang tag", () => {
    const ctx = context({
      pages: [snapshot({ hreflang: [{ href: `${SITE}/`, lang: "!!" }] })],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_INVALID");
  });

  it("reports an hreflang pointing at a page that does not exist", () => {
    const ctx = context({
      pages: [
        snapshot({
          hreflang: [
            { href: `${SITE}/`, lang: "en" },
            { href: `${SITE}/gone`, lang: "fr" },
            { href: `${SITE}/`, lang: "x-default" },
          ],
          url: "/",
        }),
      ],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_BAD_TARGET");
  });

  it("reports a missing self-reference", () => {
    const ctx = context({
      pages: [
        snapshot({
          hreflang: [{ href: `${SITE}/fr`, lang: "fr" }],
          url: "/",
        }),
        snapshot({ url: "/fr" }),
      ],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_SELF_MISSING");
  });

  it("reports a missing x-default", () => {
    const ctx = context({
      pages: [
        snapshot({ hreflang: [{ href: `${SITE}/`, lang: "en" }], url: "/" }),
      ],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_XDEFAULT_MISSING");
  });

  it("reports a lang that disagrees with the page's own hreflang", () => {
    const ctx = context({
      pages: [
        snapshot({
          hreflang: [
            { href: `${SITE}/`, lang: "de" },
            { href: `${SITE}/`, lang: "x-default" },
          ],
          lang: "en",
          url: "/",
        }),
      ],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_LANG_MISMATCH");
  });

  it("reports one language claiming two pages", () => {
    const ctx = context({
      pages: [
        snapshot({
          hreflang: [
            { href: `${SITE}/`, lang: "en" },
            { href: `${SITE}/other`, lang: "en" },
            { href: `${SITE}/`, lang: "x-default" },
          ],
          url: "/",
        }),
        snapshot({ url: "/other" }),
      ],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_CONFLICT");
  });

  it("reports a missing return tag", () => {
    // The hardest check for a real crawler — it needs the whole site at once.
    // Home names /fr as its French alternate, but /fr never names home back, so
    // Google would discard the whole cluster.
    const [home] = pair();
    const ctx = context({
      pages: [
        home as never,
        snapshot({
          hreflang: [
            { href: `${SITE}/fr`, lang: "fr" },
            { href: `${SITE}/fr`, lang: "x-default" },
          ],
          lang: "fr",
          url: "/fr",
        }),
      ],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_NO_RETURN_TAG");
  });
});
