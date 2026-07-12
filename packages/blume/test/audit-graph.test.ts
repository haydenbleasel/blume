import { describe, expect, it } from "bun:test";

import { fileToUrl, parseRobots, parseSitemap } from "../src/audit/crawl.ts";
import { buildGraph, orphanPages } from "../src/audit/graph.ts";
import { resolveRedirects } from "../src/audit/redirects.ts";
import { normalizePath, resolveHref, siteOrigin } from "../src/audit/url.ts";
import { snapshot } from "./audit-support.ts";

/** The pure layers under the checks: URL resolution, the link graph, redirects, parsers. */

const SITE = "https://x.dev";

describe("resolveHref", () => {
  it("resolves a root-relative path", () => {
    expect(resolveHref("/docs/a", "/docs/b", SITE)).toEqual({
      hash: "",
      kind: "internal",
      path: "/docs/b",
    });
  });

  it("resolves a relative path against the page as a directory", () => {
    // Astro's directory build serves /docs/a at /docs/a/, so in a browser
    // `./b` there means /docs/a/b. Resolving against the slashless form would
    // mis-target every relative link on the site by one directory level.
    expect(resolveHref("/docs/a", "./b", SITE)).toMatchObject({
      path: "/docs/a/b",
    });
    expect(resolveHref("/docs/a", "../b", SITE)).toMatchObject({
      path: "/docs/b",
    });
    expect(resolveHref("/", "b", SITE)).toMatchObject({ path: "/b" });
  });

  it("separates an absolute link back to our own origin from a real external one", () => {
    expect(resolveHref("/", `${SITE}/docs/a`, SITE)).toEqual({
      hash: "",
      kind: "self-origin",
      path: "/docs/a",
    });
    expect(resolveHref("/", "https://other.dev/x", SITE)).toEqual({
      kind: "external",
      url: "https://other.dev/x",
    });
  });

  it("treats a protocol-relative URL as absolute", () => {
    expect(resolveHref("/", "//other.dev/x", SITE)).toMatchObject({
      kind: "external",
    });
  });

  it("ignores anchors, other schemes, and empty hrefs", () => {
    // oxlint-disable-next-line no-script-url -- the point is that we ignore it
    const scheme = "javascript:x";
    for (const href of ["", "#top", "mailto:a@b.dev", "tel:123", scheme]) {
      expect(resolveHref("/", href, SITE)).toEqual({ kind: "ignored" });
    }
  });

  it("keeps the fragment and drops the query", () => {
    expect(resolveHref("/", "/docs/a?x=1#frag", SITE)).toEqual({
      hash: "frag",
      kind: "internal",
      path: "/docs/a",
    });
  });

  it("normalizes a trailing slash away", () => {
    expect(normalizePath("/docs/a/")).toBe("/docs/a");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });

  it("has no origin without a configured site", () => {
    expect(siteOrigin()).toBeNull();
    expect(siteOrigin("not a url")).toBeNull();
    expect(siteOrigin(SITE)).toBe(SITE);
  });
});

const link = (href: string, content: boolean) => ({
  content,
  href,
  rel: null,
  text: "x",
});

describe("buildGraph", () => {
  it("keeps prose edges and chrome edges apart", () => {
    const pages = [
      snapshot({
        links: [link("/b", true), link("/c", false)],
        url: "/a",
      }),
      snapshot({ url: "/b" }),
      snapshot({ url: "/c" }),
    ];
    const graph = buildGraph(pages, SITE);
    expect([...(graph.contentOut.get("/a") ?? [])]).toEqual(["/b"]);
    expect([...(graph.chromeOut.get("/a") ?? [])]).toEqual(["/c"]);
    expect([...(graph.contentIn.get("/b") ?? [])]).toEqual(["/a"]);
    expect([...(graph.chromeIn.get("/c") ?? [])]).toEqual(["/a"]);
    expect(graph.contentIn.get("/c")).toBeUndefined();
  });

  it("finds a page reachable only from the sidebar", () => {
    const pages = [
      snapshot({ links: [link("/lonely", false)], url: "/" }),
      snapshot({ url: "/lonely" }),
    ];
    const orphans = orphanPages(pages, buildGraph(pages, SITE));
    expect(orphans.map((page) => page.url)).toEqual(["/lonely"]);
  });

  it("never calls the home page or a noindex page an orphan", () => {
    const pages = [
      snapshot({ url: "/" }),
      snapshot({ indexable: false, url: "/hidden" }),
    ];
    expect(orphanPages(pages, buildGraph(pages, SITE))).toEqual([]);
  });
});

describe("resolveRedirects", () => {
  const pages = new Set(["/", "/new", "/final"]);

  it("classifies a one-hop redirect to a real page as ok", () => {
    const [result] = resolveRedirects(
      [{ from: "/old", status: 301, to: "/new" }],
      pages
    );
    expect(result?.outcome).toBe("ok");
  });

  it("classifies a redirect to nowhere as broken", () => {
    const [result] = resolveRedirects(
      [{ from: "/old", status: 301, to: "/gone" }],
      pages
    );
    expect(result?.outcome).toBe("broken");
  });

  it("follows a chain and records every hop", () => {
    const [result] = resolveRedirects(
      [
        { from: "/a", status: 301, to: "/b" },
        { from: "/b", status: 301, to: "/final" },
      ],
      pages
    );
    expect(result?.outcome).toBe("chain");
    expect(result?.chain).toEqual(["/a", "/b", "/final"]);
  });

  it("detects a loop instead of following it forever", () => {
    const [result] = resolveRedirects(
      [
        { from: "/a", status: 301, to: "/b" },
        { from: "/b", status: 301, to: "/a" },
      ],
      pages
    );
    expect(result?.outcome).toBe("loop");
  });

  it("detects a self-redirect as a loop", () => {
    const [result] = resolveRedirects(
      [{ from: "/a", status: 301, to: "/a" }],
      pages
    );
    expect(result?.outcome).toBe("loop");
  });

  it("accepts an external destination without following it", () => {
    const [result] = resolveRedirects(
      [{ from: "/a", status: 301, to: "https://other.dev/x" }],
      pages
    );
    expect(result?.outcome).toBe("ok");
  });
});

describe("fileToUrl", () => {
  it("collapses Astro's directory index files", () => {
    expect(fileToUrl("/dist", "/dist/index.html")).toBe("/");
    expect(fileToUrl("/dist", "/dist/docs/index.html")).toBe("/docs");
    expect(fileToUrl("/dist", "/dist/docs/api/index.html")).toBe("/docs/api");
    expect(fileToUrl("/dist", "/dist/404.html")).toBe("/404");
  });
});

describe("parseSitemap", () => {
  it("reads the locs out of a urlset", () => {
    const doc = parseSitemap(
      "/dist/sitemap.xml",
      '<?xml version="1.0"?><urlset><url><loc>https://x.dev/a</loc></url><url><loc>https://x.dev/b</loc></url></urlset>',
      100
    );
    expect(doc.urls).toEqual(["https://x.dev/a", "https://x.dev/b"]);
    expect(doc.error).toBeUndefined();
  });

  it("unescapes XML entities in a loc", () => {
    const doc = parseSitemap(
      "/f",
      "<urlset><url><loc>https://x.dev/a?b=1&amp;c=2</loc></url></urlset>",
      10
    );
    expect(doc.urls).toEqual(["https://x.dev/a?b=1&c=2"]);
  });

  it("rejects a document that is not a urlset", () => {
    expect(parseSitemap("/f", "<html></html>", 10).error).toBe(
      "no <urlset> element"
    );
    expect(parseSitemap("/f", "<sitemapindex></sitemapindex>", 10).error).toBe(
      "sitemap is an index, not a urlset"
    );
  });
});

describe("parseRobots", () => {
  it("reads disallow rules for the wildcard agent only", () => {
    const doc = parseRobots(
      "/dist/robots.txt",
      [
        "# a comment",
        "User-agent: *",
        "Disallow: /private",
        "User-agent: Googlebot",
        "Disallow: /google-only",
        "",
        "Sitemap: https://x.dev/sitemap.xml",
      ].join("\n")
    );
    // A rule scoped to another agent says nothing about how our pages are
    // indexed, so it must not be reported against them.
    expect(doc.disallow).toEqual(["/private"]);
    expect(doc.sitemaps).toEqual(["https://x.dev/sitemap.xml"]);
    expect(doc.invalid).toEqual([]);
  });

  it("records a line that is not a directive", () => {
    const doc = parseRobots("/f", "User-agent: *\nthis is not a directive\n");
    expect(doc.invalid).toEqual([{ line: 2, text: "this is not a directive" }]);
  });
});
