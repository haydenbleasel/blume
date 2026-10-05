import { afterAll, describe, expect, it } from "bun:test";

import {
  badResponse,
  externalChecks,
  liveRedirectCheck,
  networkChecks,
  servedPageChecks,
} from "../src/audit/checks/network.ts";
import type {
  AuditContext,
  CheckModule,
  PageSnapshot,
} from "../src/audit/types.ts";
import { gradeExternal, probe, probeAll } from "../src/core/probe.ts";
import { codes, context, snapshot } from "./audit-support.ts";

/**
 * The network tiers, driven against a local server. These checks exist to catch
 * what a `dist/` folder cannot show — a page that 404s behind a bad rewrite, an
 * `X-Robots-Tag` that deindexes a page whose HTML looks fine — so they are worth
 * having, but they must never reach the real network in a test.
 */

/** A canned fixture response. */
interface RouteFixture {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Routes the fixture server answers, keyed by pathname. */
const ROUTES = new Map<string, RouteFixture>([
  ["/", { headers: { "content-encoding": "gzip" } }],
  ["/docs/based", { headers: { "content-encoding": "gzip" } }],
  ["/gone", { status: 404 }],
  ["/insecure", { headers: { "x-robots-tag": "noindex" } }],
  ["/oops", { status: 500 }],
  ["/plain", {}],
  ["/redirects", { status: 302 }],
  ["/robots.txt", { status: 404 }],
  ["/sitemap.xml", { status: 404 }],
  // The meta-refresh page a static build writes at a redirect's old URL,
  // served by a host that never read the redirect file.
  ["/refresh-page", { body: '<meta http-equiv="refresh" content="0;url=/">' }],
  ["/slashed/", {}],
]);

/** Old URLs the fixture server redirects, and where to. */
const MOVED = new Map([
  ["/docs/moved", "/docs/based"],
  ["/moved", "/"],
  ["/moved-elsewhere", "/plain"],
  ["/moved-offsite", "/plain"],
  ["/slashed", "/slashed/"],
]);

const server = Bun.serve({
  fetch(request) {
    const { pathname } = new URL(request.url);
    const moved = MOVED.get(pathname);
    if (moved) {
      return Response.redirect(new URL(moved, request.url), 301);
    }
    const route = ROUTES.get(pathname);
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

const run = async (module: CheckModule, ctx: AuditContext): Promise<string[]> =>
  codes(await module.run(ctx));

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
    expect(gradeExternal({ ok: false, status: 410 })?.severity).toBe("error");
    expect(gradeExternal({ ok: false, status: 401 })?.severity).toBe("warning");
    expect(gradeExternal({ ok: false, status: 403 })?.severity).toBe("warning");
    expect(gradeExternal({ ok: false, status: 503 })?.severity).toBe("warning");
    expect(gradeExternal({ ok: false, timedOut: true })?.severity).toBe(
      "warning"
    );
    expect(gradeExternal({ ok: true, status: 200 })).toBeNull();
  });

  it("fails a host that doesn't exist, but only warns when one doesn't answer", () => {
    // A name that doesn't resolve is dead like a 404. A refused or dropped
    // connection is usually an outage or the runner's network.
    expect(
      gradeExternal({
        code: "ENOTFOUND",
        error: "getaddrinfo ENOTFOUND gone.dev",
        ok: false,
      })
    ).toStrictEqual({
      detail: "getaddrinfo ENOTFOUND gone.dev",
      severity: "error",
    });
    expect(
      gradeExternal({ code: "ECONNREFUSED", error: "refused", ok: false })
        ?.severity
    ).toBe("warning");
    expect(gradeExternal({ error: "boom", ok: false })?.severity).toBe(
      "warning"
    );
    expect(gradeExternal({ ok: false })?.detail).toBe("unreachable");
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

  it("probes pages under the deployment base", async () => {
    // The live site serves everything under `deployment.base`, but page URLs
    // (from the built file tree) do not carry it. The fixture server only
    // answers /docs/based, so probing without the base would 4xx a healthy page.
    const ctx = {
      ...context({ base: "/docs", pages: [snapshot({ url: "/based" })] }),
      origin: ORIGIN,
    };
    const found = await run(networkChecks, ctx);
    expect(found).not.toContain("HTTP_4XX");
    expect(found).not.toContain("NOT_COMPRESSED");
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

/** A configured 301 redirect. */
const redirect = (from: string, to: string) => ({ from, status: 301, to });

/** The live-redirect findings for `redirects`, as [url, severity, message]. */
const liveFindings = async (
  redirects: { from: string; status: number; to: string }[],
  base?: string
) => {
  const ctx = {
    ...context({
      base,
      pages: [
        snapshot({ url: "/" }),
        snapshot({ url: "/plain" }),
        snapshot({ url: "/based" }),
      ],
      redirects,
    }),
    origin: ORIGIN,
  };
  const found = await networkChecks.run(ctx);
  return found
    .filter((d) => d.code === "BLUME_AUDIT_REDIRECT_NOT_SERVED")
    .map((d) => [d.url, d.severity, d.message]);
};

describe("live redirects", () => {
  it("requests each old URL and is silent when it redirects as configured", async () => {
    expect(
      await liveFindings([
        redirect("/moved", "/"),
        // An external destination isn't compared: its site may redirect again.
        redirect("/moved-offsite", "https://example.com/elsewhere"),
      ])
    ).toEqual([]);
  });

  it("reports an old URL the live site doesn't redirect", async () => {
    expect(
      await liveFindings([
        redirect("/never-deployed", "/"),
        redirect("/refresh-page", "/"),
        redirect("/slashed", "/"),
        redirect("/moved-elsewhere", "/"),
      ])
    ).toEqual([
      [
        "/never-deployed",
        "error",
        "/never-deployed should redirect to /, but the live site answered it with HTTP 404 instead.",
      ],
      [
        "/refresh-page",
        "warning",
        "/refresh-page should redirect to /, but the live site answered it with HTTP 200 instead.",
      ],
      [
        "/slashed",
        "warning",
        "/slashed should redirect to /, but the live site answered it with HTTP 200 instead.",
      ],
      [
        "/moved-elsewhere",
        "warning",
        "/moved-elsewhere redirects to /plain on the live site, not to /.",
      ],
    ]);
  });

  it("requests only the redirects the static checks passed", async () => {
    // None of these is served by the fixture, so a request would report it.
    expect(
      await liveFindings([
        redirect("/beta/:slug*", "/"),
        redirect("/loop-a", "/loop-b"),
        redirect("/loop-b", "/loop-a"),
        redirect("/plain", "/"),
        redirect("/nowhere", "/missing"),
      ])
    ).toEqual([]);
  });

  it("requests old URLs under the deployment base", async () => {
    expect(await liveFindings([redirect("/moved", "/based")], "/docs")).toEqual(
      []
    );
  });

  it("reports an old URL that never answered", () => {
    const ctx = context({ redirects: [redirect("/old", "/")] });
    const [resolved] = ctx.redirects;
    if (!resolved) {
      throw new Error("expected the redirect");
    }
    const message = (result: Parameters<typeof liveRedirectCheck>[2]) =>
      liveRedirectCheck(ctx, resolved, result, "")?.message;
    expect(message({ ok: false, timedOut: true })).toBe(
      "/old should redirect to /, but the live site did not respond in time."
    );
    expect(message({ error: "ECONNREFUSED", ok: false })).toBe(
      "/old should redirect to /, but the live site could not be reached (ECONNREFUSED)."
    );
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

  it("leaves out an outbound link that --ignore matches", async () => {
    const ctx = context({
      ignore: (url) => url === `${ORIGIN}/gone`,
      pages: [
        snapshot({
          links: [link(`${ORIGIN}/gone`), link(`${ORIGIN}/redirects`)],
          url: "/",
        }),
      ],
      site: "https://x.dev",
    });
    expect(await run(externalChecks, ctx)).toEqual(["EXTERNAL_LINK_REDIRECT"]);
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
