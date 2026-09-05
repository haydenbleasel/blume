import { describe, expect, it } from "bun:test";

import {
  ACCEPT_MARKDOWN_HEADER_VALUE,
  buildNegotiationRoutes,
  injectNegotiationRoutes,
} from "../src/deploy/vercel-negotiation.ts";

// The router's matching semantics aren't contractual — exercise the pattern
// both as a substring match and wrapped as a full-string match, since it must
// behave identically either way.
const partial = new RegExp(ACCEPT_MARKDOWN_HEADER_VALUE, "u");
const full = new RegExp(`^(?:${ACCEPT_MARKDOWN_HEADER_VALUE})$`, "u");

const matchesBoth = (accept: string): boolean => {
  const a = partial.test(accept);
  const b = full.test(accept);
  expect(a).toBe(b);
  return a;
};

describe("accept-header pattern", () => {
  it("matches Markdown accept headers under both matching semantics", () => {
    expect(matchesBoth("text/markdown")).toBe(true);
    expect(matchesBoth("text/x-markdown")).toBe(true);
    expect(matchesBoth("text/markdown;q=0.9")).toBe(true);
    expect(matchesBoth("text/markdown, */*")).toBe(true);
    expect(matchesBoth("text/html, text/markdown;q=0.9")).toBe(true);
    expect(matchesBoth("application/json,text/markdown")).toBe(true);
  });

  it("rejects browser and non-Markdown accept headers", () => {
    expect(matchesBoth("text/html")).toBe(false);
    expect(
      matchesBoth("text/html,application/xhtml+xml,application/xml;q=0.9,*/*")
    ).toBe(false);
    expect(matchesBoth("*/*")).toBe(false);
    expect(matchesBoth("application/json")).toBe(false);
    // A longer media type must not match on its `text/markdown` prefix.
    expect(matchesBoth("text/markdownx")).toBe(false);
  });
});

describe("buildNegotiationRoutes", () => {
  it("builds a conditional rewrite and a Vary route over the content routes", () => {
    const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes([
      "/docs/a",
      "/docs/b",
    ]);
    expect(rewriteRoutes).toStrictEqual([
      {
        dest: "$1.md",
        has: [
          {
            key: "accept",
            type: "header",
            value: ACCEPT_MARKDOWN_HEADER_VALUE,
          },
        ],
        headers: { vary: "Accept" },
        src: "^(/docs/a|/docs/b)/?$",
      },
    ]);
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
    expect(rewriteRoutes[1]?.src).toBe("^(/guide)/?$");
    // The Vary route covers the home page alongside the rest.
    const vary = new RegExp(headerRoutes[0]?.src ?? "", "u");
    expect(vary.test("/")).toBe(true);
    expect(vary.test("/guide")).toBe(true);
  });

  it("stamps x-markdown-tokens on the home rewrite when a count is given", () => {
    const { rewriteRoutes } = buildNegotiationRoutes(["/", "/guide"], 128);
    expect(rewriteRoutes[0]?.headers).toStrictEqual({
      vary: "Accept",
      "x-markdown-tokens": "128",
    });
    // Chunked rewrites span many pages, so a per-page count never rides them.
    expect(rewriteRoutes[1]?.headers).toStrictEqual({ vary: "Accept" });
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
    // Every route is matched by exactly one rewrite entry.
    for (const path of routes) {
      const matches = rewriteRoutes.filter((route) =>
        new RegExp(route.src ?? "", "u").test(path)
      );
      expect(matches).toHaveLength(1);
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
      "^/(.+)/$",
      undefined,
      "^/_astro/(.*)$",
      "^/api/ask/?$",
      "^/.*$",
    ]);
    expect(config.routes[3]).toStrictEqual({ handle: "filesystem" });
    expect(config.routes[0].continue).toBe(true);
    expect(config.routes[1].dest).toBe("$1.md");
  });

  it("splices a trailing-slash 308 redirect after the rewrites", () => {
    const injected = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    const config = JSON.parse(injected ?? "");
    const redirect = config.routes.find(
      (route: { status?: number }) => route.status === 308
    );
    expect(redirect).toStrictEqual({
      headers: { Location: "/$1" },
      src: "^/(.+)/$",
      status: 308,
    });
    // Main phase, after the Markdown rewrite (so a slashed URL's negotiation
    // rewrites directly) and before handle:filesystem (so it actually fires
    // for prerendered pages).
    const redirectIndex = config.routes.indexOf(redirect);
    const rewriteIndex = config.routes.findIndex(
      (route: { dest?: string }) => route.dest === "$1.md"
    );
    const filesystemIndex = config.routes.findIndex(
      (route: { handle?: string }) => route.handle === "filesystem"
    );
    expect(redirectIndex).toBeGreaterThan(rewriteIndex);
    expect(redirectIndex).toBeLessThan(filesystemIndex);
    // The pattern spares the root and strips exactly one trailing slash.
    const src = new RegExp(redirect.src, "u");
    expect(src.test("/")).toBe(false);
    expect(src.test("/docs/a")).toBe(false);
    expect("/docs/a/".replace(src, "/$1")).toBe("/docs/a");
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
    expect(updated).toHaveLength(1);
    expect(updated[0].headers["x-markdown-tokens"]).toBe("512");
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

  it("still injects the trailing-slash redirect with nothing else to add", () => {
    const text = JSON.stringify(baseConfig);
    for (const injected of [
      injectNegotiationRoutes(text, []),
      injectNegotiationRoutes(text, [], null),
      injectNegotiationRoutes(text, [], null, {}),
    ]) {
      const config = JSON.parse(injected ?? "");
      expect(
        config.routes.filter(
          (route: { status?: number }) => route.status === 308
        )
      ).toHaveLength(1);
    }
  });

  it("splices the Markdown 404 routes right before the adapter's /404.html fallback", () => {
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      true
    );
    const config = JSON.parse(injected ?? "");
    const routes: {
      dest?: string;
      handle?: string;
      has?: { key: string; type: string; value: string }[];
      headers?: Record<string, string>;
      src?: string;
      status?: number;
    }[] = config.routes;
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
    expect(routes[fallbackIndex - 2]).toStrictEqual({
      dest: "/404.md",
      has: [
        { key: "accept", type: "header", value: ACCEPT_MARKDOWN_HEADER_VALUE },
      ],
      headers: { vary: "Accept" },
      src: "^/.*$",
      status: 404,
    });
    expect(routes[fallbackIndex - 1]).toStrictEqual({
      dest: "/404.md",
      src: "^/.*\\.mdx?$",
      status: 404,
    });
    expect(fallbackIndex - 2).toBeGreaterThan(serverIndex);
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
      true
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
      true
    );
    const twice = injectNegotiationRoutes(
      once ?? "",
      ["/docs/a"],
      null,
      undefined,
      undefined,
      true
    );
    expect(twice).toBe(once ?? "");
    expect((once ?? "").match(/\/404\.md/gu)).toHaveLength(2);
    // Dropping the flag on a re-injection removes them again.
    const dropped = injectNegotiationRoutes(once ?? "", ["/docs/a"]);
    expect(dropped).not.toContain("/404.md");
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
