import { describe, expect, it } from "bun:test";

import { contentChecks } from "../src/audit/checks/content.ts";
import { linkChecks } from "../src/audit/checks/links.ts";
import { buildSnapshot } from "../src/audit/snapshot.ts";
import type { AuditContext, CheckModule } from "../src/audit/types.ts";
import type { Diagnostic } from "../src/core/types.ts";
import { codes, context, manifestRoute, snapshot } from "./audit-support.ts";

/**
 * Findings a healthy site must not get: an inline SVG's own `<title>`, an
 * i18n fallback copy nobody links to, and a text-fragment link.
 */

// SAFETY: the content and link checks run synchronously; only the network
// tiers return a promise.
const run = (module: CheckModule, ctx: AuditContext): string[] =>
  codes(module.run(ctx) as Diagnostic[]);

const link = (href: string) => ({
  content: true,
  href,
  rel: null,
  text: "x",
});

const ICON =
  '<svg role="img" aria-labelledby="t"><title id="t">GitHub</title><g><title>Nested</title><path d=""/></g></svg>';

const html = (head: string, body: string): string =>
  `<!doctype html><html lang="en"><head>${head}</head><body><main><h1>Page</h1>${body}</main></body></html>`;

const titlesOf = (source: string): string[] =>
  buildSnapshot({ file: "/dist/index.html", html: source, url: "/a" }).titles;

describe("inline SVG titles", () => {
  it("counts only the document's own title", () => {
    const titles = titlesOf(html("<title>The page</title>", ICON));
    expect(titles).toEqual(["The page"]);
    const ctx = context({ pages: [snapshot({ titles })] });
    expect(run(contentChecks, ctx)).not.toContain("TITLE_MULTIPLE");
  });

  it("does not let an SVG title stand in for a missing page title", () => {
    const titles = titlesOf(html("", ICON));
    expect(titles).toEqual([]);
    const ctx = context({ pages: [snapshot({ titles })] });
    expect(run(contentChecks, ctx)).toContain("TITLE_MISSING");
  });
});

describe("orphan pages", () => {
  it("skips an i18n fallback copy", () => {
    const ctx = context({
      pages: [
        snapshot({ links: [link("/guide")], url: "/" }),
        snapshot({ url: "/guide" }),
        snapshot({
          route: manifestRoute({
            fallback: true,
            locale: "fr",
            path: "/fr/guide",
          }),
          url: "/fr/guide",
        }),
      ],
    });
    expect(run(linkChecks, ctx)).not.toContain("ORPHAN_PAGE");
  });

  it("still reports a real translation nothing links to", () => {
    const ctx = context({
      pages: [
        snapshot({ url: "/" }),
        snapshot({
          route: manifestRoute({ locale: "fr", path: "/fr/guide" }),
          url: "/fr/guide",
        }),
      ],
    });
    expect(run(linkChecks, ctx)).toContain("ORPHAN_PAGE");
  });
});

describe("text fragments", () => {
  const pages = (href: string) => [
    snapshot({ ids: new Set(["setup"]), links: [link(href)], url: "/" }),
    snapshot({ ids: new Set(["install"]), links: [link("/")], url: "/b" }),
  ];

  it("ignores a bare text fragment, on this page or another", () => {
    for (const href of [
      "#:~:text=Lorem",
      "/b#:~:text=Lorem%20ipsum",
      "/b#:~:text=a&text=b",
    ]) {
      expect(run(linkChecks, context({ pages: pages(href) }))).not.toContain(
        "ANCHOR_BROKEN"
      );
    }
  });

  it("checks the element fragment in front of the directive", () => {
    const good = context({ pages: pages("/b#install:~:text=Run") });
    expect(run(linkChecks, good)).not.toContain("ANCHOR_BROKEN");
    const bad = context({ pages: pages("#gone:~:text=Run") });
    // SAFETY: the link checks run synchronously (see `run` above).
    const found = linkChecks.run(bad) as Diagnostic[];
    expect(codes(found)).toContain("ANCHOR_BROKEN");
    expect(found.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "#gone on this page"
    );
  });
});
