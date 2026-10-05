import { describe, expect, it } from "bun:test";

import { prefersMarkdown } from "../src/astro/markdown-negotiation.ts";
import {
  ACCEPT_JSON_CONDITIONS,
  ACCEPT_MARKDOWN_CONDITIONS,
  buildNegotiationRoutes,
  injectNegotiationRoutes,
} from "../src/deploy/vercel-negotiation.ts";
import type {
  AcceptConditions,
  VercelRoute,
} from "../src/deploy/vercel-negotiation.ts";

// The router's matching semantics aren't contractual — exercise each pattern
// both as a substring match and wrapped as a full-string match, since it must
// behave identically either way.
const matchesBoth = (pattern: string | undefined, accept: string): boolean => {
  const partial = new RegExp(pattern ?? "", "u").test(accept);
  const full = new RegExp(`^(?:${pattern ?? ""})$`, "u").test(accept);
  expect(partial).toBe(full);
  return partial;
};

/**
 * Whether a route written once per condition pair fires for `accept`: all of
 * one pair's `has`, and none of its `missing`, match.
 */
const fires = (
  conditions: readonly AcceptConditions[],
  accept: string
): boolean =>
  conditions.some(
    ({ has, missing = [] }) =>
      has.every((condition) => matchesBoth(condition.value, accept)) &&
      !missing.some((condition) => matchesBoth(condition.value, accept))
  );

describe("accept-header conditions", () => {
  it("negotiate Markdown the way dev and Cloudflare do", () => {
    const headers = [
      // Markdown.
      "text/markdown",
      "text/x-markdown",
      "Text/Markdown",
      "TEXT/X-MARKDOWN; charset=utf-8",
      "text/markdown;q=1",
      "text/markdown ; q=1.0, text/html",
      "text/html, text/markdown",
      "text/markdown;q=0.9",
      "text/markdown; charset=utf-8; q=0.8, */*;q=0.1",
      "text/markdown;q=.5, text/html;q=0",
      "text/markdown;Q=0.5",
      "application/json,text/markdown",
      "text/markdown;q=0, text/x-markdown",
      // HTML.
      "text/html",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*",
      "*/*",
      "application/json",
      "text/markdown;q=0",
      "text/markdown; q=0.000",
      "text/markdown;q=",
      "text/html, text/markdown;q=0.9",
      "TEXT/HTML, text/markdown;q=0.9",
      "text/markdown;q=0.5, text/html",
      "text/markdown;q=0.9, text/html;q=0.95",
      // A longer media type must not match on its `text/markdown` prefix.
      "text/markdownx",
      "text/markdown x",
    ];
    for (const accept of headers) {
      expect({
        accept,
        negotiated: fires(ACCEPT_MARKDOWN_CONDITIONS, accept),
      }).toStrictEqual({ accept, negotiated: prefersMarkdown(accept) });
    }
  });

  it("serve HTML when Markdown and HTML both weigh in below 1", () => {
    // A routing condition can't compare two q-values; dev and Cloudflare
    // send Markdown here.
    for (const accept of [
      "text/markdown;q=0.9, text/html;q=0.8",
      "text/html;q=0.5, text/markdown;q=0.5",
    ]) {
      expect(prefersMarkdown(accept)).toBe(true);
      expect(fires(ACCEPT_MARKDOWN_CONDITIONS, accept)).toBe(false);
    }
  });

  it("negotiate JSON the same way", () => {
    for (const accept of [
      "application/json",
      "Application/Problem+JSON",
      "application/json;q=0.9",
      "application/json, text/plain",
      "text/html, application/json",
    ]) {
      expect(fires(ACCEPT_JSON_CONDITIONS, accept)).toBe(true);
    }
    for (const accept of [
      "*/*",
      "text/html,application/xhtml+xml",
      "application/jsonx",
      "application/json;q=0",
      "text/html, application/json;q=0.9",
    ]) {
      expect(fires(ACCEPT_JSON_CONDITIONS, accept)).toBe(false);
    }
  });
});

describe("buildNegotiationRoutes", () => {
  it("builds a conditional rewrite and a Vary route over the content routes", () => {
    const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes([
      "/docs/a",
      "/docs/b",
    ]);
    // One rewrite per condition pair: full-weight Markdown, and partial
    // weight with no HTML above zero.
    expect(rewriteRoutes).toStrictEqual(
      ACCEPT_MARKDOWN_CONDITIONS.map((conditions) => ({
        dest: "$1.md",
        headers: { vary: "Accept" },
        src: "^(/docs/a|/docs/b)/?$",
        ...conditions,
      }))
    );
    expect(rewriteRoutes[1]?.missing).toHaveLength(1);
    expect(headerRoutes).toStrictEqual([
      {
        continue: true,
        headers: { vary: "Accept" },
        src: "^(?:/docs/a|/docs/b)/?$",
      },
    ]);
  });

  it("rewrites a matched page URL to its .md mirror, trailing slash included", () => {
    const { rewriteRoutes } = buildNegotiationRoutes(["/docs/a", "/docs/b"]);
    const [route] = rewriteRoutes;
    const src = new RegExp(route?.src ?? "", "u");
    expect("/docs/b/".replace(src, route?.dest ?? "")).toBe("/docs/b.md");
    expect("/docs/a".replace(src, route?.dest ?? "")).toBe("/docs/a.md");
    expect(src.test("/docs/ab")).toBe(false);
    expect(src.test("/logo.png")).toBe(false);
  });

  it("maps the home page to /index.md via a dedicated route", () => {
    const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes([
      "/",
      "/guide",
    ]);
    expect(rewriteRoutes[0]).toMatchObject({
      dest: "/index.md",
      src: "^/$",
    });
    expect(rewriteRoutes[1]).toMatchObject({
      dest: "/index.md",
      src: "^/$",
    });
    expect(rewriteRoutes[2]?.src).toBe("^(/guide)/?$");
    // The Vary route covers the home page alongside the rest.
    const vary = new RegExp(headerRoutes[0]?.src ?? "", "u");
    expect(vary.test("/")).toBe(true);
    expect(vary.test("/guide")).toBe(true);
  });

  it("stamps x-markdown-tokens on the home rewrite when a count is given", () => {
    const { rewriteRoutes } = buildNegotiationRoutes(["/", "/guide"], 128);
    for (const home of rewriteRoutes.slice(0, 2)) {
      expect(home.headers).toStrictEqual({
        vary: "Accept",
        "x-markdown-tokens": "128",
      });
    }
    // Chunked rewrites span many pages, so a per-page count never rides them.
    expect(rewriteRoutes[2]?.headers).toStrictEqual({ vary: "Accept" });
    // Without a count the home rewrite stays as before.
    const plain = buildNegotiationRoutes(["/", "/guide"]);
    expect(plain.rewriteRoutes[0]?.headers).toStrictEqual({ vary: "Accept" });
  });

  it("percent-encodes and regex-escapes route paths", () => {
    const { rewriteRoutes } = buildNegotiationRoutes([
      "/ja/はじめに",
      "/docs/c++ (v2)",
    ]);
    const src = rewriteRoutes[0]?.src ?? "";
    expect(src).toContain(encodeURI("/ja/はじめに"));
    expect(src).toContain("/docs/c\\+\\+%20\\(v2\\)");
    const pattern = new RegExp(src, "u");
    expect(pattern.test(encodeURI("/ja/はじめに"))).toBe(true);
    expect(pattern.test("/docs/cxx (v2)")).toBe(false);
  });

  it("splits large route sets across entries under the src length limit", () => {
    const routes = Array.from(
      { length: 300 },
      (_, index) => `/docs/section-${index}/some-fairly-long-page-slug-${index}`
    );
    const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes(routes);
    expect(rewriteRoutes.length).toBeGreaterThan(1);
    for (const route of [...rewriteRoutes, ...headerRoutes]) {
      expect((route.src ?? "").length).toBeLessThan(4096);
    }
    // Every route is matched by exactly one chunk's pair of rewrites.
    for (const path of routes) {
      const matches = rewriteRoutes.filter((route) =>
        new RegExp(route.src ?? "", "u").test(path)
      );
      expect(matches).toHaveLength(ACCEPT_MARKDOWN_CONDITIONS.length);
      expect(new Set(matches.map((route) => route.src)).size).toBe(1);
    }
  });
});

const baseConfig = {
  routes: [
    { handle: "filesystem" },
    {
      continue: true,
      headers: { "cache-control": "public, max-age=31536000, immutable" },
      src: "^/_astro/(.*)$",
    },
    { dest: "_render", src: "^/api/ask/?$" },
    { dest: "/404.html", src: "^/.*$", status: 404 },
  ],
  version: 3,
};

/** The negotiated 404 routes for `dest`, one per condition pair. */
const negotiatedNotFound = (
  dest: string,
  conditions: readonly AcceptConditions[]
): VercelRoute[] =>
  conditions.map((condition) => ({
    dest,
    headers: { vary: "Accept" },
    src: "^/.*$",
    status: 404,
    ...condition,
  }));

describe("injectNegotiationRoutes", () => {
  it("splices Vary routes then rewrites, all before handle:filesystem", () => {
    const injected = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    expect(injected).not.toBeNull();
    const config = JSON.parse(injected ?? "");
    expect(config.version).toBe(3);
    expect(config.routes.map((route: { src?: string }) => route.src)).toEqual([
      "^(?:/docs/a)/?$",
      "^(/docs/a)/?$",
      "^(/docs/a)/?$",
      undefined,
      "^/_astro/(.*)$",
      "^/api/ask/?$",
      "^/.*$",
    ]);
    expect(config.routes[3]).toStrictEqual({ handle: "filesystem" });
    expect(config.routes[0].continue).toBe(true);
    expect(config.routes[1].dest).toBe("$1.md");
    expect(config.routes[2].dest).toBe("$1.md");
  });

  it("leaves the trailing-slash redirect to the adapter", () => {
    // The generated config sets Astro's `trailingSlash: "never"`, which the
    // Vercel adapter turns into the platform's own 308 route; splicing a
    // second one would only duplicate it.
    const injected = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    const config = JSON.parse(injected ?? "");
    expect(
      config.routes.filter((route: { status?: number }) => route.status === 308)
    ).toHaveLength(0);
  });

  it("is idempotent across re-injection", () => {
    const once = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
      "/docs/b",
    ]);
    const twice = injectNegotiationRoutes(once ?? "", ["/docs/a", "/docs/b"]);
    expect(twice).toBe(once ?? "");
  });

  it("emits tab-indented JSON with a trailing newline", () => {
    const injected = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    expect(injected?.endsWith("}\n")).toBe(true);
    expect(injected).toContain('\n\t"routes"');
  });

  it("splices a homepage Link route before handle:filesystem when given", () => {
    const link = '</llms.txt>; rel="describedby"; type="text/plain"';
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      link
    );
    const config = JSON.parse(injected ?? "");
    const filesystemIndex = config.routes.findIndex(
      (route: { handle?: string }) => route.handle === "filesystem"
    );
    const linkRoute = config.routes.find(
      (route: { headers?: Record<string, string> }) => route.headers?.link
    );
    expect(linkRoute).toStrictEqual({
      continue: true,
      headers: { link },
      src: "^/$",
    });
    // Main phase: the marker starts the miss phase, which prerendered static
    // responses (the homepage included) never reach.
    expect(config.routes.indexOf(linkRoute)).toBeLessThan(filesystemIndex);
  });

  it("injects only the Link route when there are no content routes", () => {
    const link = '</llms.txt>; rel="describedby"; type="text/plain"';
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      [],
      link
    );
    const config = JSON.parse(injected ?? "");
    expect(
      config.routes.filter(
        (route: { has?: unknown; headers?: Record<string, string> }) =>
          route.has || route.headers?.vary
      )
    ).toHaveLength(0);
    expect(
      config.routes.filter(
        (route: { headers?: Record<string, string> }) => route.headers?.link
      )
    ).toHaveLength(1);
  });

  it("injects the home token count and stays idempotent", () => {
    const once = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/", "/docs/a"],
      null,
      undefined,
      256
    );
    const config = JSON.parse(once ?? "");
    const homeRewrite = config.routes.find(
      (route: { dest?: string }) => route.dest === "/index.md"
    );
    expect(homeRewrite.headers).toStrictEqual({
      vary: "Accept",
      "x-markdown-tokens": "256",
    });
    // Re-injection with a fresh count replaces rather than duplicates.
    const twice = injectNegotiationRoutes(
      once ?? "",
      ["/", "/docs/a"],
      null,
      undefined,
      512
    );
    const updated = JSON.parse(twice ?? "").routes.filter(
      (route: { dest?: string }) => route.dest === "/index.md"
    );
    expect(updated).toHaveLength(ACCEPT_MARKDOWN_CONDITIONS.length);
    for (const route of updated) {
      expect(route.headers["x-markdown-tokens"]).toBe("512");
    }
  });

  it("replaces a previously injected Link route instead of duplicating it", () => {
    const once = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      "old"
    );
    const twice = injectNegotiationRoutes(once ?? "", ["/docs/a"], "new");
    const config = JSON.parse(twice ?? "");
    const linkRoutes = config.routes.filter(
      (route: { headers?: Record<string, string> }) => route.headers?.link
    );
    expect(linkRoutes).toHaveLength(1);
    expect(linkRoutes[0].headers.link).toBe("new");
    expect(injectNegotiationRoutes(twice ?? "", ["/docs/a"], "new")).toBe(
      twice ?? ""
    );
  });

  it("adds content-type overrides for extensionless well-known files", () => {
    const overrides = {
      ".well-known/http-message-signatures-directory":
        "application/http-message-signatures-directory+json",
    };
    const once = injectNegotiationRoutes(
      JSON.stringify({
        ...baseConfig,
        overrides: { "kept.html": { path: "kept" } },
      }),
      ["/docs/a"],
      null,
      overrides
    );
    const config = JSON.parse(once ?? "");
    expect(config.overrides).toStrictEqual({
      ".well-known/http-message-signatures-directory": {
        contentType: "application/http-message-signatures-directory+json",
      },
      "kept.html": { path: "kept" },
    });
    // Re-injection replaces the keyed entry instead of duplicating anything.
    expect(
      injectNegotiationRoutes(once ?? "", ["/docs/a"], null, overrides)
    ).toBe(once ?? "");
    // Overrides alone are enough to warrant an injection.
    const alone = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      [],
      null,
      overrides
    );
    expect(JSON.parse(alone ?? "").overrides).toBeDefined();
  });

  it("stamps Access-Control-Allow-Origin on the discovery documents before handle:filesystem", () => {
    const cors = ["/.well-known/ai-catalog.json", "/.well-known/api-catalog"];
    const once = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      [],
      null,
      {},
      undefined,
      {},
      cors
    );
    const routes: VercelRoute[] = JSON.parse(once ?? "").routes;
    const filesystemIndex = routes.findIndex(
      (route) => route.handle === "filesystem"
    );
    const corsRoutes = routes.filter(
      (route) => route.headers?.["access-control-allow-origin"] === "*"
    );
    expect(corsRoutes).toStrictEqual([
      {
        continue: true,
        headers: { "access-control-allow-origin": "*" },
        src: "^/\\.well-known/ai-catalog\\.json$",
      },
      {
        continue: true,
        headers: { "access-control-allow-origin": "*" },
        src: "^/\\.well-known/api-catalog$",
      },
    ]);
    for (const route of corsRoutes) {
      expect(routes.indexOf(route)).toBeLessThan(filesystemIndex);
    }
    // Re-injection replaces the CORS routes instead of duplicating them.
    expect(
      injectNegotiationRoutes(once ?? "", [], null, {}, undefined, {}, cors)
    ).toBe(once ?? "");
  });

  it("returns the config untouched-in-shape when there is nothing to add", () => {
    const text = JSON.stringify(baseConfig);
    for (const injected of [
      injectNegotiationRoutes(text, []),
      injectNegotiationRoutes(text, [], null),
      injectNegotiationRoutes(text, [], null, {}),
    ]) {
      const config = JSON.parse(injected ?? "");
      expect(config.routes).toHaveLength(baseConfig.routes.length);
    }
  });

  it("splices the Markdown 404 routes right before the adapter's /404.html fallback", () => {
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { markdown: true }
    );
    const routes: VercelRoute[] = JSON.parse(injected ?? "").routes;
    const fallbackIndex = routes.findIndex(
      (route) => route.dest === "/404.html"
    );
    expect(fallbackIndex).toBeGreaterThan(0);
    // Miss phase (after handle:filesystem), after the server routes, and
    // immediately ahead of the HTML fallback.
    const filesystemIndex = routes.findIndex(
      (route) => route.handle === "filesystem"
    );
    const serverIndex = routes.findIndex((route) => route.dest === "_render");
    expect(routes.slice(fallbackIndex - 3, fallbackIndex - 1)).toStrictEqual(
      negotiatedNotFound("/404.md", ACCEPT_MARKDOWN_CONDITIONS)
    );
    expect(routes[fallbackIndex - 1]).toStrictEqual({
      dest: "/404.md",
      src: "^/.*\\.mdx?$",
      status: 404,
    });
    expect(fallbackIndex - 3).toBeGreaterThan(serverIndex);
    expect(serverIndex).toBeGreaterThan(filesystemIndex);
    // The `.md` route catches raw-mirror URLs without a page, not pages.
    const mdSrc = new RegExp(routes[fallbackIndex - 1]?.src ?? "", "u");
    expect(mdSrc.test("/docs/missing.md")).toBe(true);
    expect(mdSrc.test("/docs/missing.mdx")).toBe(true);
    expect(mdSrc.test("/docs/missing")).toBe(false);
    expect(mdSrc.test("/logo.png")).toBe(false);
  });

  it("leaves the Markdown 404 out by default and when no HTML fallback exists", () => {
    const withoutFlag = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    expect(withoutFlag).not.toContain("/404.md");

    const noFallback = {
      routes: baseConfig.routes.filter((route) => route.status !== 404),
      version: 3,
    };
    const injected = injectNegotiationRoutes(
      JSON.stringify(noFallback),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { markdown: true }
    );
    expect(injected).not.toBeNull();
    expect(injected).not.toContain("/404.md");
  });

  it("re-injects the Markdown 404 routes idempotently", () => {
    const once = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { markdown: true }
    );
    const twice = injectNegotiationRoutes(
      once ?? "",
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { markdown: true }
    );
    expect(twice).toBe(once ?? "");
    expect((once ?? "").match(/\/404\.md/gu)).toHaveLength(3);
    // Dropping the flag on a re-injection removes them again.
    const dropped = injectNegotiationRoutes(once ?? "", ["/docs/a"]);
    expect(dropped).not.toContain("/404.md");
  });

  it("splices the JSON 404 routes at the same anchor, after the Markdown ones", () => {
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { json: true, markdown: true }
    );
    const routes: VercelRoute[] = JSON.parse(injected ?? "").routes;
    const fallbackIndex = routes.findIndex(
      (route) => route.dest === "/404.html"
    );
    expect(routes.slice(fallbackIndex - 6, fallbackIndex)).toStrictEqual([
      ...negotiatedNotFound("/404.md", ACCEPT_MARKDOWN_CONDITIONS),
      { dest: "/404.md", src: "^/.*\\.mdx?$", status: 404 },
      ...negotiatedNotFound("/404.json", ACCEPT_JSON_CONDITIONS),
      { dest: "/404.json", src: "^/.*\\.json$", status: 404 },
    ]);
    // The `.json` route catches JSON URLs no file backs, nothing else.
    const jsonSrc = new RegExp(routes[fallbackIndex - 1]?.src ?? "", "u");
    expect(jsonSrc.test("/api/docs/pages/missing.json")).toBe(true);
    expect(jsonSrc.test("/docs/missing")).toBe(false);
    expect(jsonSrc.test("/docs/missing.md")).toBe(false);

    // JSON alone, and idempotently.
    const jsonOnly = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { json: true }
    );
    expect(jsonOnly).not.toContain("/404.md");
    expect((jsonOnly ?? "").match(/\/404\.json/gu)).toHaveLength(3);
    const twice = injectNegotiationRoutes(
      jsonOnly ?? "",
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { json: true }
    );
    expect(twice).toBe(jsonOnly ?? "");
    const dropped = injectNegotiationRoutes(jsonOnly ?? "", ["/docs/a"]);
    expect(dropped).not.toContain("/404.json");
  });

  it("returns null when there is nowhere to splice", () => {
    expect(injectNegotiationRoutes("not json", ["/docs/a"])).toBeNull();
    expect(injectNegotiationRoutes("{}", ["/docs/a"])).toBeNull();
    expect(
      injectNegotiationRoutes(JSON.stringify({ routes: [{ src: "^/x$" }] }), [
        "/docs/a",
      ])
    ).toBeNull();
  });
});
