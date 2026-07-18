import { describe, expect, it } from "bun:test";

import {
  attr,
  metaContents,
  parseHtml,
  visibleText,
} from "../src/audit/html.ts";
import { buildSnapshot } from "../src/audit/snapshot.ts";
import type { RouteManifestEntry } from "../src/core/types.ts";

/**
 * Extraction from built HTML. Everything downstream reads the snapshot, so a
 * miss here silently disables whole checks rather than reporting a false one.
 */

const page = (body: string, head = ""): string =>
  `<!doctype html><html lang="en"><head><title>A title</title>${head}</head><body>${body}</body></html>`;

const snap = (html: string, route?: RouteManifestEntry) =>
  buildSnapshot({ file: "/dist/index.html", html, route, url: "/docs/x" });

describe("buildSnapshot", () => {
  it("collects every element id as an anchor target", () => {
    const result = snap(
      page(
        '<main><h1 id="setup">Setup</h1><h2 id="install">Install</h2><div id="app"></div><p>No id here.</p></main>'
      )
    );
    expect(result.ids).toEqual(new Set(["setup", "install", "app"]));
  });

  it("pulls the head tags an audit reads", () => {
    const result = snap(
      page(
        "<main><h1>Heading</h1></main>",
        [
          '<meta name="description" content="A description.">',
          '<meta name="viewport" content="width=device-width">',
          '<meta name="robots" content="noindex">',
          '<meta http-equiv="refresh" content="0; url=/x">',
          '<link rel="canonical" href="https://x.dev/docs/x">',
          '<link rel="alternate" hreflang="fr" href="https://x.dev/fr/docs/x">',
          '<meta property="og:title" content="A title">',
          '<meta name="twitter:card" content="summary">',
        ].join("")
      )
    );

    expect(result.lang).toBe("en");
    expect(result.titles).toEqual(["A title"]);
    expect(result.descriptions).toEqual(["A description."]);
    expect(result.viewport).toBe("width=device-width");
    expect(result.robots).toBe("noindex");
    expect(result.indexable).toBe(false);
    expect(result.metaRefresh).toBe("0; url=/x");
    expect(result.canonical).toBe("https://x.dev/docs/x");
    expect(result.hreflang).toEqual([
      { href: "https://x.dev/fr/docs/x", lang: "fr" },
    ]);
    expect(result.og).toEqual({ "og:title": "A title" });
    expect(result.twitter).toEqual({ "twitter:card": "summary" });
    expect(result.headings).toEqual([{ depth: 1, text: "Heading" }]);
  });

  it("keeps every title and description so duplicates are visible", () => {
    const result = snap(
      page(
        "<main>x</main>",
        '<title>Second</title><meta name="description" content="One"><meta name="description" content="Two">'
      )
    );
    expect(result.titles).toEqual(["A title", "Second"]);
    expect(result.descriptions).toEqual(["One", "Two"]);
  });

  it("separates prose links from chrome links", () => {
    // The sidebar links every page from every page. Without this split the link
    // graph reports zero orphans and multiplies every bad nav link by N pages.
    const result = snap(
      page(
        '<nav><a href="/nav">Nav</a></nav><main><a href="/body">Body</a></main><footer><a href="/foot">Foot</a></footer>'
      )
    );
    expect(result.links).toEqual([
      { content: false, href: "/nav", rel: null, text: "Nav" },
      { content: true, href: "/body", rel: null, text: "Body" },
      { content: false, href: "/foot", rel: null, text: "Foot" },
    ]);
  });

  it("does not count a nav nested inside main as prose", () => {
    const result = snap(
      page('<main><nav><a href="/inner">Inner</a></nav></main>')
    );
    expect(result.links[0]?.content).toBe(false);
  });

  it("excludes code blocks from the word count", () => {
    // A page that is 90% code samples is not a well-documented page, and letting
    // its snippets pad the count would defeat the low-word-count check.
    const result = snap(
      page(
        "<main><p>Four real prose words.</p><pre><code>const a = 1; const b = 2; const c = 3;</code></pre></main>"
      )
    );
    expect(result.wordCount).toBe(4);
  });

  it("hashes prose so identical pages collide and different ones do not", () => {
    const a = snap(page("<main><p>Same words here.</p></main>"));
    const b = snap(page("<main><p>Same words here.</p></main>"));
    const c = snap(page("<main><p>Different words entirely.</p></main>"));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });

  it("collects assets, distinguishing a missing alt from a decorative one", () => {
    const result = snap(
      page(
        '<main><img src="/a.png"><img src="/b.png" alt="" width="10" height="20"></main><script src="/a.js"></script>',
        '<link rel="stylesheet" href="/a.css">'
      )
    );
    expect(result.images[0]).toMatchObject({ alt: null, src: "/a.png" });
    expect(result.images[1]).toMatchObject({
      alt: "",
      height: "20",
      src: "/b.png",
      width: "10",
    });
    expect(result.scripts.map((s) => s.src)).toEqual(["/a.js"]);
    expect(result.styles.map((s) => s.src)).toEqual(["/a.css"]);
  });

  it("parses JSON-LD and keeps the parse failures", () => {
    const result = snap(
      page(
        "<main>x</main>",
        '<script type="application/ld+json">{"@type":"WebSite"}</script><script type="application/ld+json">{oops}</script>'
      )
    );
    expect(result.jsonld).toEqual([{ "@type": "WebSite" }]);
    expect(result.jsonldErrors).toHaveLength(1);
  });

  it("falls back from main to body for a page with no landmark", () => {
    const result = snap(page("<p>Loose prose with no main element.</p>"));
    expect(result.wordCount).toBe(6);
  });

  it("carries the source file through from the route manifest", () => {
    const route = { sourcePath: "/docs/x.mdx" } as RouteManifestEntry;
    expect(snap(page("<main>x</main>"), route).source).toBe("/docs/x.mdx");
    expect(snap(page("<main>x</main>")).source).toBeUndefined();
  });
});

describe("html helpers", () => {
  it("treats an empty attribute as absent", () => {
    const document = parseHtml('<html lang=""><body></body></html>');
    expect(attr(document.querySelector("html") ?? document, "lang")).toBeNull();
  });

  it("skips a meta tag with no content", () => {
    const document = parseHtml(
      '<meta name="description"><meta name="description" content="Real">'
    );
    expect(metaContents(document, 'meta[name="description"]')).toEqual([
      "Real",
    ]);
  });

  it("collapses whitespace in visible text", () => {
    const document = parseHtml("<main><p>a</p>\n\n  <p>b</p></main>");
    expect(visibleText(document.querySelector("main") ?? document)).toBe("a b");
  });
});
