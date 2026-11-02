import { describe, expect, it } from "bun:test";

import { fileToUrl, parseRobots, parseSitemap } from "../src/audit/crawl.ts";
import { buildGraph, orphanPages } from "../src/audit/graph.ts";
import { redirectAt, resolveRedirects } from "../src/audit/redirects.ts";
import {
  decodePath,
  normalizePath,
  resolveHref,
  siteOrigin,
} from "../src/audit/url.ts";
import { withBasePath } from "../src/core/base-path.ts";
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

  it("resolves a relative path the way a browser does from the slashless URL", () => {
    // Pages are served at their slashless canonical URL (`trailingSlash:
    // "never"`), so `./b` on /docs/a means /docs/b — where the click lands.
    expect(resolveHref("/docs/a", "./b", SITE)).toMatchObject({
      path: "/docs/b",
    });
    expect(resolveHref("/docs/a", "../guides/b", SITE)).toMatchObject({
      path: "/guides/b",
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

  it("strips the deployment base from emitted hrefs", () => {
    // Hrefs carry `deployment.base`; the built file tree (and page URLs) don't.
    expect(resolveHref("/docs/a", "/base/docs/b", SITE, "/base")).toEqual({
      hash: "",
      kind: "internal",
      path: "/docs/b",
    });
    expect(resolveHref("/", `${SITE}/base/docs/a`, SITE, "/base")).toEqual({
      hash: "",
      kind: "self-origin",
      path: "/docs/a",
    });
    // A path not under the base is untouched.
    expect(resolveHref("/", "/other/x", SITE, "/base")).toMatchObject({
      path: "/other/x",
    });
  });

  it("resolves a percent-encoded href to the raw UTF-8 path", () => {
    // Page URLs and file-index keys come from raw on-disk names; hrefs in built
    // HTML are percent-encoded. A Japanese route would never match its own page
    // without decoding.
    expect(resolveHref("/", "/%E3%82%AC%E3%82%A4%E3%83%89", SITE)).toEqual({
      hash: "",
      kind: "internal",
      path: "/ガイド",
    });
    expect(
      resolveHref("/", `${SITE}/%E3%82%AC%E3%82%A4%E3%83%89`, SITE)
    ).toEqual({
      hash: "",
      kind: "self-origin",
      path: "/ガイド",
    });
  });

  it("passes a malformed percent sequence through unchanged", () => {
    // A sequence our own encoder could never have produced is kept as-is
    // instead of throwing.
    expect(decodePath("/%E0%A4%A")).toBe("/%E0%A4%A");
    expect(decodePath("/%E3%82%AC")).toBe("/ガ");
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

  it("exempts a basePath home page from the orphan check", () => {
    const pages = [snapshot({ url: "/docs" })];
    expect(orphanPages(pages, buildGraph(pages, SITE), "/docs")).toEqual([]);
  });
});

describe("resolveRedirects", () => {
  const pages = new Set(["/", "/new", "/final"]);
  const served = (path: string) => pages.has(path);

  it("classifies a one-hop redirect to a real page as ok", () => {
    const [result] = resolveRedirects(
      [{ from: "/old", status: 301, to: "/new" }],
      served
    );
    expect(result?.outcome).toBe("ok");
  });

  it("accepts a redirect to a served static file", () => {
    const [result] = resolveRedirects(
      [{ from: "/old-whitepaper", status: 301, to: "/files/whitepaper.pdf" }],
      (path) => served(path) || path === "/files/whitepaper.pdf"
    );
    expect(result?.outcome).toBe("ok");
  });

  it("classifies a redirect to nowhere as broken", () => {
    const [result] = resolveRedirects(
      [{ from: "/old", status: 301, to: "/gone" }],
      served
    );
    expect(result?.outcome).toBe("broken");
  });

  it("follows a chain and records every hop", () => {
    const [result] = resolveRedirects(
      [
        { from: "/a", status: 301, to: "/b" },
        { from: "/b", status: 301, to: "/final" },
      ],
      served
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
      served
    );
    expect(result?.outcome).toBe("loop");
  });

  it("leaves a pattern unwalked, and follows a hop through one", () => {
    const [pattern, via] = resolveRedirects(
      [
        { from: "/beta/:slug*", status: 301, to: "/v2/:slug*" },
        { from: "/older", status: 301, to: "/beta/final" },
        { from: "/v2/final", status: 301, to: "/final" },
      ],
      // `/beta` itself goes to `/v2`.
      (path) => served(path) || path === "/v2"
    );
    expect(pattern?.outcome).toBe("pattern");
    expect(via?.chain).toEqual([
      "/older",
      "/beta/final",
      "/v2/final",
      "/final",
    ]);
    expect(via?.outcome).toBe("chain");
  });

  it("walks the bare path a pattern's rest also matches", () => {
    // Every host gets `/mcp /user-api` beside `/mcp/* /user-api/:splat`, so
    // a `/user-api` that isn't served breaks `/mcp`.
    const [broken, through, loop, ok] = resolveRedirects(
      [
        { from: "/mcp/*", status: 301, to: "/user-api/*" },
        { from: "/beta/:slug*", status: 301, to: "/older" },
        { from: "/a/*", status: 301, to: "/a" },
        { from: "/fine/*", status: 301, to: "/new" },
        { from: "/older", status: 301, to: "/gone" },
      ],
      served
    );
    expect(broken?.outcome).toBe("broken");
    expect(broken?.chain).toEqual(["/mcp", "/user-api"]);
    expect(through?.outcome).toBe("broken");
    expect(through?.chain).toEqual(["/beta", "/older", "/gone"]);
    expect(loop?.outcome).toBe("loop");
    expect(loop?.chain).toEqual(["/a", "/a"]);
    // A bare path that lands leaves the pattern as it was.
    expect(ok?.outcome).toBe("pattern");
    // One whose bare path holds a capture names no single path to walk.
    const [captured] = resolveRedirects(
      [{ from: "/:lang/*", status: 301, to: "/gone" }],
      served
    );
    expect(captured?.outcome).toBe("pattern");
  });

  it("calls a walk that never ends a loop", () => {
    // `/x` → `/a/b` → `/a/b/b` → …: no hop repeats, and none lands.
    const [result] = resolveRedirects(
      [
        { from: "/x", status: 301, to: "/a/b" },
        { from: "/a/*", status: 301, to: "/a/b/:splat" },
      ],
      served
    );
    expect(result?.outcome).toBe("loop");
    expect(result?.chain.length).toBeGreaterThan(32);
  });

  it("detects a self-redirect as a loop", () => {
    const [result] = resolveRedirects(
      [{ from: "/a", status: 301, to: "/a" }],
      served
    );
    expect(result?.outcome).toBe("loop");
  });

  it("resolves a destination with a fragment or query to its page", () => {
    // `/new#setup` and `/search?q=x` land on the `/new` / `/search` pages — the
    // suffix belongs to the browser, not the file tree.
    const [withFragment, withQuery] = resolveRedirects(
      [
        { from: "/old", status: 301, to: "/new#setup" },
        { from: "/older", status: 301, to: "/new?q=x" },
      ],
      served
    );
    expect(withFragment?.outcome).toBe("ok");
    expect(withQuery?.outcome).toBe("ok");
  });

  it("resolves configured redirects against based page URLs under a basePath", () => {
    // Mirrors runAudit: redirects are authored as if mounted at root, but built
    // page URLs carry `basePath` (it is a real directory in the build), so both
    // sides gain it before resolution.
    const basePath = "/docs";
    const [result] = resolveRedirects(
      [
        {
          from: withBasePath(basePath, "/old"),
          status: 301,
          to: withBasePath(basePath, "/new"),
        },
      ],
      (path) => path === "/docs" || path === "/docs/new"
    );
    expect(result?.outcome).toBe("ok");
    expect(result?.chain).toEqual(["/docs/old", "/docs/new"]);
  });

  it("accepts an external destination without following it", () => {
    const [result] = resolveRedirects(
      [{ from: "/a", status: 301, to: "https://other.dev/x" }],
      served
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

  it("reads CDATA locs, numeric entities, and namespaced elements", () => {
    // All three are legal sitemap XML that other generators emit and that a
    // regex scan never saw: the audit also runs against non-Blume sitemaps.
    const doc = parseSitemap(
      "/f",
      '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        "<sm:url><sm:loc><![CDATA[https://x.dev/cdata]]></sm:loc>" +
        "<sm:lastmod>2026-01-05</sm:lastmod></sm:url>" +
        "<sm:url><sm:loc>https://x.dev/a?b=1&#38;c=2</sm:loc></sm:url>" +
        "</sm:urlset>",
      10
    );
    expect(doc.urls).toEqual([
      "https://x.dev/cdata",
      "https://x.dev/a?b=1&c=2",
    ]);
    expect(doc.lastmod?.get("https://x.dev/cdata")).toBe("2026-01-05");
    expect(doc.error).toBeUndefined();
  });

  it("skips url entries that carry no usable loc", () => {
    // Text-only and self-closed <url> elements, a loc that is blank, and an
    // entry with only a lastmod contribute nothing; their neighbors still do.
    const doc = parseSitemap(
      "/f",
      `<urlset>
        <url>text</url>
        <url/>
        <url><loc>   </loc></url>
        <url><lastmod>2026-01-01</lastmod></url>
        <url><loc>https://x.dev/kept</loc></url>
      </urlset>`,
      10
    );
    expect(doc.error).toBeUndefined();
    expect(doc.urls).toEqual(["https://x.dev/kept"]);
    expect([...(doc.lastmod?.keys() ?? [])]).toEqual([]);
  });

  it("rejects a document that is not a urlset or sitemap index", () => {
    expect(parseSitemap("/f", "<html></html>", 10).error).toBe(
      "no <urlset> element"
    );
  });

  it("reads a sitemap index's child sitemaps instead of rejecting it", () => {
    const doc = parseSitemap(
      "/f",
      `<sitemapindex>
        <sitemap><loc> https://x.dev/sitemap-1.xml </loc></sitemap>
        <sitemap><loc>https://x.dev/sitemap-2.xml</loc></sitemap>
        <sitemap><lastmod>2026-01-01</lastmod></sitemap>
        <sitemap>text</sitemap>
      </sitemapindex>`,
      10
    );
    expect(doc.error).toBeUndefined();
    expect(doc.sitemaps).toEqual([
      "https://x.dev/sitemap-1.xml",
      "https://x.dev/sitemap-2.xml",
    ]);
    expect(
      parseSitemap("/f", "<sitemapindex></sitemapindex>", 10).sitemaps
    ).toEqual([]);
  });
});

describe("parseRobots", () => {
  it("collects sitemap declarations and keeps the raw text for matching", () => {
    const text = [
      "# a comment",
      "User-agent: *",
      "Disallow: /private",
      "",
      "Sitemap: https://x.dev/sitemap.xml",
    ].join("\n");
    const doc = parseRobots("/dist/robots.txt", text);
    expect(doc.sitemaps).toEqual(["https://x.dev/sitemap.xml"]);
    expect(doc.invalid).toEqual([]);
    expect(doc.raw).toBe(text);
  });

  it("records a line that is not a directive", () => {
    const doc = parseRobots("/f", "User-agent: *\nthis is not a directive\n");
    expect(doc.invalid).toEqual([{ line: 2, text: "this is not a directive" }]);
  });
});

describe(redirectAt, () => {
  const redirects = resolveRedirects(
    [
      { from: "/old", status: 301, to: "/new" },
      { from: "/beta/:slug*", status: 301, to: "/v2/:slug*" },
    ],
    () => true
  );

  it("finds the exact redirect from a path, else the pattern covering it", () => {
    expect(redirectAt(redirects, "/old")?.to).toBe("/new");
    expect(redirectAt(redirects, "/beta/a/b")).toEqual({ to: "/v2/a/b" });
    expect(redirectAt(redirects, "/elsewhere")).toBeUndefined();
  });
});
