import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";
import {
  applyBaseToAstroRedirects,
  applyBaseToPlatformRedirects,
  buildNetlifyRedirects,
  buildRedirectManifest,
  buildVercelConfig,
  platformRedirects,
} from "../src/deploy/redirects.ts";

const redirects = [
  { from: "/old", status: 301 as const, to: "/new" },
  { from: "/tmp", status: 302 as const, to: "/temp" },
];

/** No served page routes: none of these targets is a dotted path anyway. */
const NO_ROUTES = new Set<string>();

describe("redirect emitters", () => {
  it("writes Netlify `_redirects` lines (from to status)", () => {
    expect(buildNetlifyRedirects(redirects)).toBe(
      "/old /new 301\n/tmp /temp 302\n"
    );
  });

  it("preserves exact status codes in vercel.json via statusCode", () => {
    const parsed = JSON.parse(buildVercelConfig(redirects));
    expect(parsed.redirects[0]).toStrictEqual({
      destination: "/new",
      source: "/old",
      statusCode: 301,
    });
    // A 302 must ship as 302 — the boolean `permanent` would coerce it to 307.
    expect(parsed.redirects[1].statusCode).toBe(302);
    expect(parsed.redirects[1]).not.toHaveProperty("permanent");
  });

  it("adds a headers array to vercel.json only when there are rules", () => {
    const headers = [
      {
        headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }],
        source: "/(.*).txt",
      },
    ];
    expect(JSON.parse(buildVercelConfig([], headers))).toStrictEqual({
      headers,
      redirects: [],
    });
    expect(JSON.parse(buildVercelConfig(redirects))).not.toHaveProperty(
      "headers"
    );
  });

  it("prepends the base path to internal from/to routes", () => {
    expect(
      applyBaseToAstroRedirects(redirects, "/docs", "", NO_ROUTES)
    ).toStrictEqual([
      { from: "/docs/old", status: 301, to: "/docs/new" },
      { from: "/docs/tmp", status: 302, to: "/docs/temp" },
    ]);
    expect(
      applyBaseToPlatformRedirects(redirects, "/docs", "", NO_ROUTES)
    ).toStrictEqual([
      { from: "/docs/old", status: 301, to: "/docs/new" },
      { from: "/docs/tmp", status: 302, to: "/docs/temp" },
    ]);
    // No base of either kind: the redirects pass through untouched.
    expect(applyBaseToAstroRedirects(redirects, "", "", NO_ROUTES)).toBe(
      redirects
    );
    expect(applyBaseToPlatformRedirects(redirects, "", "", NO_ROUTES)).toBe(
      redirects
    );
  });

  it("bases redirects from the resolved config via platformRedirects", () => {
    // The one spelling every platform consumer (redirect files, Cloudflare
    // worker-first exemptions) must share: both sides carry the full
    // `{deployment.base}{basePath}` stack.
    // SAFETY: platformRedirects reads only basePath, deployment.base, and
    // redirects; the rest of ResolvedConfig is irrelevant to this test.
    const config = {
      basePath: "/docs",
      deployment: { options: { base: "/base" } },
      redirects,
    } as ResolvedConfig;
    expect(
      platformRedirects({ config, manifest: { routes: [] } })
    ).toStrictEqual(
      applyBaseToPlatformRedirects(redirects, "/docs", "/base", NO_ROUTES)
    );
    // SAFETY: same three fields as above — everything platformRedirects reads.
    const unbased = {
      basePath: "",
      deployment: { options: {} },
      redirects,
    } as ResolvedConfig;
    expect(
      platformRedirects({ config: unbased, manifest: { routes: [] } })
    ).toBe(redirects);
  });

  it("bases only `to` for Astro, which applies `base` to `from` itself", () => {
    // Astro matches `from` against a pattern it builds with `base` applied, but
    // passes `to` through without it — so only `to` carries the deploy base.
    expect(
      applyBaseToAstroRedirects(redirects, "", "/base", NO_ROUTES)
    ).toStrictEqual([
      { from: "/old", status: 301, to: "/base/new" },
      { from: "/tmp", status: 302, to: "/base/temp" },
    ]);
  });

  it("stacks deployment.base and basePath as {base}/{basePath} for Astro", () => {
    expect(
      applyBaseToAstroRedirects(redirects, "/docs", "/base", NO_ROUTES)
    ).toStrictEqual([
      { from: "/docs/old", status: 301, to: "/base/docs/new" },
      { from: "/docs/tmp", status: 302, to: "/base/docs/temp" },
    ]);
  });

  it("bases both sides of a platform redirect against the served URL", () => {
    // The host matches these against the real URL, so `from` needs the deploy
    // base that Astro would otherwise add on its own.
    expect(
      applyBaseToPlatformRedirects(redirects, "/docs", "/base", NO_ROUTES)
    ).toStrictEqual([
      { from: "/base/docs/old", status: 301, to: "/base/docs/new" },
      { from: "/base/docs/tmp", status: 302, to: "/base/docs/temp" },
    ]);
    expect(
      applyBaseToPlatformRedirects(redirects, "", "/base", NO_ROUTES)
    ).toStrictEqual([
      { from: "/base/old", status: 301, to: "/base/new" },
      { from: "/base/tmp", status: 302, to: "/base/temp" },
    ]);
  });

  it("normalizes a raw deployment.base before composing", () => {
    // Astro accepts `/base/` and even `base` for its `base` option; a verbatim
    // concatenation would emit `/base//new` or a relative `base/new`.
    expect(
      applyBaseToAstroRedirects(redirects, "", "/base/", NO_ROUTES)
    ).toStrictEqual([
      { from: "/old", status: 301, to: "/base/new" },
      { from: "/tmp", status: 302, to: "/base/temp" },
    ]);
    expect(
      applyBaseToPlatformRedirects(redirects, "", "base", NO_ROUTES)
    ).toStrictEqual([
      { from: "/base/old", status: 301, to: "/base/new" },
      { from: "/base/tmp", status: 302, to: "/base/temp" },
    ]);
  });

  it("leaves a hand-written base and external destinations alone", () => {
    const authored = [
      { from: "/old", status: 301 as const, to: "/base/docs/new" },
      { from: "/away", status: 301 as const, to: "https://example.com/new" },
    ];
    expect(
      applyBaseToAstroRedirects(authored, "/docs", "/base", NO_ROUTES)
    ).toStrictEqual([
      // Already under the full stack: kept as-is rather than doubled.
      { from: "/docs/old", status: 301, to: "/base/docs/new" },
      { from: "/docs/away", status: 301, to: "https://example.com/new" },
    ]);
    expect(
      applyBaseToPlatformRedirects(authored, "/docs", "/base", NO_ROUTES)
    ).toStrictEqual([
      { from: "/base/docs/old", status: 301, to: "/base/docs/new" },
      { from: "/base/docs/away", status: 301, to: "https://example.com/new" },
    ]);
  });

  it("emits a structured manifest", () => {
    expect(JSON.parse(buildRedirectManifest(redirects))).toStrictEqual([
      { from: "/old", status: 301, to: "/new" },
      { from: "/tmp", status: 302, to: "/temp" },
    ]);
  });
});

/** The config paths a single redirect fails validation at. */
const redirectIssues = (redirect: { from: string; to: string }): string[] => {
  const result = blumeConfigSchema.safeParse({ redirects: [redirect] });
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
};

describe("redirect paths", () => {
  it("rejects a `:param` segment or a `*` wildcard at either end", () => {
    expect(
      redirectIssues({ from: "/legacy/:slug", to: "/guides/:slug" })
    ).toEqual(["redirects.0.from", "redirects.0.to"]);
    expect(redirectIssues({ from: "/old/*", to: "/new" })).toEqual([
      "redirects.0.from",
    ]);
    expect(
      redirectIssues({ from: "/old", to: "https://example.com/a/:b" })
    ).toEqual(["redirects.0.to"]);
  });

  it("accepts exact paths, dotted routes, and absolute URLs with a port", () => {
    expect(
      redirectIssues({ from: "/releases/v1.0", to: "/v1/releases" })
    ).toEqual([]);
    expect(
      redirectIssues({ from: "/a:b", to: "https://example.com:8080/new" })
    ).toEqual([]);
  });
});
