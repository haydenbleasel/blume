import { afterAll, describe, expect, it } from "bun:test";

import {
  badResponse,
  externalChecks,
  networkChecks,
  servedPageChecks,
} from "../src/audit/checks/network.ts";
import type { PageSnapshot } from "../src/audit/types.ts";
import { gradeExternal, probe, probeAll } from "../src/core/probe.ts";
import type { Diagnostic } from "../src/core/types.ts";
import { codes, context, snapshot } from "./audit-support.ts";

/**
 * The network tiers, driven against a local server. These checks exist to catch
 * what a `dist/` folder cannot show — a page that 404s behind a bad rewrite, an
 * `X-Robots-Tag` that deindexes a page whose HTML looks fine — so they are worth
 * having, but they must never reach the real network in a test.
 */

/** Routes the fixture server answers, keyed by pathname. */
const ROUTES: Record<
  string,
  { status?: number; headers?: Record<string, string>; body?: string }
> = {
  "/": { headers: { "content-encoding": "gzip" } },
  "/gone": { status: 404 },
  "/insecure": { headers: { "x-robots-tag": "noindex" } },
  "/oops": { status: 500 },
  "/plain": {},
  "/redirects": { status: 302 },
  "/robots.txt": { status: 404 },
  "/sitemap.xml": { status: 404 },
};

const server = Bun.serve({
  fetch(request) {
    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    if (pathname === "/redirects") {
      return Response.redirect(new URL("/", request.url), 302);
    }
    return new Response(route.body ?? "ok", {
      headers: route.headers ?? {},
      status: route.status ?? 200,
    });
  },
  port: 0,
});

const ORIGIN = `http://localhost:${server.port}`;

afterAll(() => {
  server.stop(true);
});

const run = async (
  module: { run: (c: never) => unknown },
  ctx: unknown
): Promise<string[]> => codes((await module.run(ctx as never)) as Diagnostic[]);

const withOrigin = (pages: PageSnapshot[]) => ({
  ...context({ pages }),
  origin: ORIGIN,
});

describe("probe", () => {
  it("reports a healthy URL", async () => {
    const result = await probe(`${ORIGIN}/`);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.encoding).toBe("gzip");
  });

  it("normalizes an unreachable host instead of throwing", async () => {
    // Port 1 is reserved and refuses instantly, so this stays offline.
    const result = await probe("http://127.0.0.1:1/", { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("deduplicates before probing", async () => {
    const results = await probeAll([
      `${ORIGIN}/`,
      `${ORIGIN}/`,
      `${ORIGIN}/gone`,
    ]);
    expect(results.size).toBe(2);
  });
});

describe("gradeExternal", () => {
  it("treats a 404 as an error and a 403 as a warning", () => {
    // A 404 is the author's bug. A 403 is usually rate limiting or a bot wall,
    // and failing a build on it would get --external switched off for good.
    expect(gradeExternal({ ok: false, status: 404 })?.severity).toBe("error");
    expect(gradeExternal({ ok: false, status: 403 })?.severity).toBe("warning");
    expect(gradeExternal({ ok: false, status: 503 })?.severity).toBe("warning");
    expect(gradeExternal({ ok: false, timedOut: true })?.severity).toBe(
      "warning"
    );
    expect(gradeExternal({ error: "boom", ok: false })?.severity).toBe("error");
    expect(gradeExternal({ ok: true, status: 200 })).toBeNull();
  });
});

describe("network checks", () => {
  it("does nothing without --url", async () => {
    expect(await run(networkChecks, context())).toEqual([]);
  });

  it("reports a page that is in the build but 404s in production", async () => {
    const found = await run(
      networkChecks,
      withOrigin([snapshot({ url: "/gone" })])
    );
    expect(found).toContain("HTTP_4XX");
  });

  it("reports a page that errors", async () => {
    const found = await run(
      networkChecks,
      withOrigin([snapshot({ url: "/oops" })])
    );
    expect(found).toContain("HTTP_5XX");
  });

  it("reports an uncompressed page", async () => {
    const found = await run(
      networkChecks,
      withOrigin([snapshot({ url: "/plain" })])
    );
    expect(found).toContain("NOT_COMPRESSED");
  });

  it("does not report a compressed page as uncompressed", async () => {
    const found = await run(
      networkChecks,
      withOrigin([snapshot({ url: "/" })])
    );
    expect(found).not.toContain("NOT_COMPRESSED");
  });

  it("reports an X-Robots-Tag that silently deindexes an indexable page", async () => {
    // The header wins over the meta tag, so the HTML can look perfectly fine
    // while the page is invisible to search. Only a live probe can see it.
    const found = await run(
      networkChecks,
      withOrigin([snapshot({ url: "/insecure" })])
    );
    expect(found).toContain("ROBOTS_HEADER_CONFLICT");
  });

  it("reports a sitemap that is in the build but unreachable", async () => {
    const ctx = {
      ...context({ pages: [snapshot({ url: "/" })] }),
      origin: ORIGIN,
      sitemap: { bytes: 10, file: "/dist/sitemap.xml", urls: [] },
    };
    expect(await run(networkChecks, ctx)).toContain("SITEMAP_NOT_ACCESSIBLE");
  });

  it("reports an unreachable robots.txt", async () => {
    const found = await run(
      networkChecks,
      withOrigin([snapshot({ url: "/" })])
    );
    expect(found).toContain("ROBOTS_NOT_ACCESSIBLE");
  });
});

describe("response grading", () => {
  // Driven with synthetic responses: a timeout, a slow first byte, and an
  // HTTPS→HTTP downgrade are all awkward to provoke from a local HTTP server,
  // and standing up a fake network to produce them would only test the fake.
  const ctx = context();
  const page = snapshot({ url: "/x" });
  const grade = (result: Parameters<typeof badResponse>[2]) =>
    codes([badResponse(ctx, page, result)].filter((d) => d !== null));
  const served = (
    result: Parameters<typeof servedPageChecks>[2],
    origin: string
  ) => codes(servedPageChecks(ctx, page, result, origin));

  it("reports a timeout", () => {
    expect(grade({ ok: false, timedOut: true })).toEqual(["HTTP_TIMEOUT"]);
  });

  it("reports a host that never answered", () => {
    expect(grade({ error: "ECONNREFUSED", ok: false })).toEqual(["HTTP_5XX"]);
  });

  it("passes a healthy response through", () => {
    expect(grade({ ok: true, status: 200 })).toEqual([]);
  });

  it("reports an HTTPS page that redirects down to HTTP", () => {
    const found = served(
      {
        encoding: "gzip",
        finalUrl: "http://x.dev/x",
        ok: true,
        redirected: true,
        status: 200,
      },
      "https://x.dev"
    );
    expect(found).toContain("REDIRECT_TO_HTTP");
  });

  it("does not flag an HTTP origin redirecting within HTTP", () => {
    const found = served(
      {
        encoding: "gzip",
        finalUrl: "http://x.dev/x",
        ok: true,
        redirected: true,
        status: 200,
      },
      "http://x.dev"
    );
    expect(found).not.toContain("REDIRECT_TO_HTTP");
  });

  it("reports a slow response", () => {
    expect(
      served({ encoding: "br", ms: 5000, ok: true }, "https://x.dev")
    ).toEqual(["SLOW_RESPONSE"]);
  });
});

const link = (href: string) => ({
  content: true,
  href,
  rel: null,
  text: "x",
});

describe("external checks", () => {
  it("is silent when there are no outbound links", async () => {
    expect(await run(externalChecks, context())).toEqual([]);
  });

  it("reports a broken outbound link", async () => {
    const ctx = context({
      pages: [snapshot({ links: [link(`${ORIGIN}/gone`)], url: "/" })],
      site: "https://x.dev",
    });
    const found = await run(externalChecks, ctx);
    expect(found).toContain("EXTERNAL_LINK_BROKEN");
  });

  it("does not report a healthy outbound link", async () => {
    const ctx = context({
      pages: [snapshot({ links: [link(`${ORIGIN}/`)], url: "/" })],
      site: "https://x.dev",
    });
    expect(await run(externalChecks, ctx)).toEqual([]);
  });

  it("reports an outbound link that redirects", async () => {
    const ctx = context({
      pages: [snapshot({ links: [link(`${ORIGIN}/redirects`)], url: "/" })],
      site: "https://x.dev",
    });
    expect(await run(externalChecks, ctx)).toContain("EXTERNAL_LINK_REDIRECT");
  });

  it("probes a shared outbound link once, not once per linking page", async () => {
    const ctx = context({
      pages: [
        snapshot({ links: [link(`${ORIGIN}/gone`)], url: "/a" }),
        snapshot({ links: [link(`${ORIGIN}/gone`)], url: "/b" }),
      ],
      site: "https://x.dev",
    });
    const found = await run(externalChecks, ctx);
    expect(found).toEqual(["EXTERNAL_LINK_BROKEN"]);
  });
});
