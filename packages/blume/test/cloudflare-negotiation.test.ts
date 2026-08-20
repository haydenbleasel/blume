import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import {
  markdownVariantUrl,
  prefersMarkdown,
} from "../src/astro/markdown-negotiation.ts";
import {
  buildNegotiationWorker,
  buildRunWorkerFirstRules,
  injectWorkerNegotiation,
  mergeRunWorkerFirstRules,
  NEGOTIATION_WORKER_FILE,
} from "../src/deploy/cloudflare-negotiation.ts";

const ROUTES = [
  "/",
  "/docs/quickstart",
  "/docs/guides/advanced",
  "/changelog",
  "/ja/はじめに",
];

const HOME_LINK = '</llms.txt>; rel="describedby"; type="text/plain"';

/**
 * Configured redirects as `deploy/redirects.ts` bases them for a host
 * platform: a retired page and a non-ASCII page, both with non-default
 * statuses so a defaulted 301 cannot pass by accident.
 */
const REDIRECTS = [
  { from: "/docs/api", status: 302, to: "/docs/api-reference" },
  { from: "/ja/古い", status: 307, to: "/ja/新しい" },
];

/** The slices of the adapter's wrangler config a test overrides. */
interface WranglerOverrides {
  assets?:
    | {
        binding?: string;
        directory: string;
        run_worker_first?: string[] | boolean;
      }
    | undefined;
  main?: string | undefined;
}

/** The adapter-shaped `dist/server/wrangler.json` the injection rewrites. */
const wranglerConfig = (overrides: WranglerOverrides = {}): string =>
  JSON.stringify({
    assets: { binding: "ASSETS", directory: "../client" },
    main: "index.js",
    name: "site",
    no_bundle: true,
    ...overrides,
  });

/**
 * The Astro Worker the wrapper delegates to: records each delegated request
 * URL on the env and answers with the env-provided response, so tests observe
 * the wrapper's routing decisions without a real adapter bundle.
 */
const SERVER_STUB = `export default {
  fetch(request, env) {
    env.serverCalls.push(request.url);
    return Promise.resolve(env.serverResponse());
  },
};
`;

/** The harness env the stub server and the wrapper's negotiation read. */
interface WorkerEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  serverCalls: string[];
  serverResponse: () => Response;
}

/** The subset of Cloudflare's ExecutionContext the wrapper forwards. */
interface WorkerExecutionContext {
  waitUntil?: (task: Promise<Response>) => void;
}

interface WorkerModule {
  fetch: (
    request: Request,
    env: WorkerEnv,
    context: WorkerExecutionContext
  ) => Promise<Response>;
}

/** Write the wrapper (and the stub it imports) to a temp dir and import it. */
const loadWorker = async (workerText: string): Promise<WorkerModule> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-cf-negotiation-"));
  await writeFile(join(dir, "index.js"), SERVER_STUB, "utf-8");
  const file = join(dir, NEGOTIATION_WORKER_FILE);
  await writeFile(file, workerText, "utf-8");
  // SAFETY: the file written two lines up is the generated wrapper Worker,
  // which default-exports a `{ fetch }` module.
  const loaded = (await import(pathToFileURL(file).href)) as {
    default: WorkerModule;
  };
  return loaded.default;
};

interface HarnessCalls {
  assets: string[];
  server: string[];
}

interface Harness {
  calls: HarnessCalls;
  env: WorkerEnv;
}

const makeEnv = (
  options: { assetsStatus?: number; serverResponse?: () => Response } = {}
): Harness => {
  const calls: HarnessCalls = { assets: [], server: [] };
  return {
    calls,
    env: {
      ASSETS: {
        fetch: (request: Request): Promise<Response> => {
          calls.assets.push(request.url);
          const status = options.assetsStatus ?? 200;
          return Promise.resolve(
            new Response(status === 200 ? "# markdown" : null, {
              headers: { "content-type": "text/markdown" },
              status,
            })
          );
        },
      },
      serverCalls: calls.server,
      serverResponse:
        options.serverResponse ??
        ((): Response =>
          new Response("<html>", {
            headers: { "content-type": "text/html" },
          })),
    },
  };
};

const workerText = (
  overrides: Partial<Parameters<typeof buildNegotiationWorker>[0]> = {}
): string =>
  buildNegotiationWorker({
    assetsBinding: "ASSETS",
    homeLinkHeader: HOME_LINK,
    homeTokens: 123,
    mainSpecifier: "./index.js",
    routePaths: ROUTES,
    ...overrides,
  });

describe("negotiation worker — parity with the dev middleware helpers", () => {
  // The worker embeds a JavaScript copy of `astro/markdown-negotiation.ts`;
  // these vectors pin its behavior to the TypeScript originals.
  const acceptVectors = [
    "text/markdown",
    "text/x-markdown",
    "text/markdown;q=0.9",
    "text/markdown, */*",
    "application/json,text/markdown",
    "text/html, text/markdown;q=0.9",
    "text/markdown;q=0",
    "text/markdown;q=oops",
    "text/html",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*",
    "*/*",
    "application/json",
  ];

  it("negotiates exactly when prefersMarkdown does", async () => {
    const worker = await loadWorker(workerText());
    for (const accept of acceptVectors) {
      const { calls, env } = makeEnv();
      // oxlint-disable-next-line no-await-in-loop -- sequential vectors
      await worker.fetch(
        new Request("https://site.test/docs/quickstart/", {
          headers: { accept },
        }),
        env,
        {}
      );
      expect(calls.assets.length).toBe(prefersMarkdown(accept) ? 1 : 0);
    }
  });

  it("maps request URLs to the same variant as markdownVariantUrl", async () => {
    const worker = await loadWorker(workerText());
    const routes = new Set(ROUTES);
    const paths = [
      "/",
      "/docs/quickstart",
      "/docs/quickstart/",
      "/docs/quickstart/?tab=cli",
      "/docs/guides/advanced/",
      "/ja/%E3%81%AF%E3%81%98%E3%82%81%E3%81%AB",
      "/changelog/",
      "/not-a-route/",
      "/docs/",
      "/mcp",
    ];
    for (const path of paths) {
      const { calls, env } = makeEnv();
      // oxlint-disable-next-line no-await-in-loop -- sequential vectors
      await worker.fetch(
        new Request(`https://site.test${path}`, {
          headers: { accept: "text/markdown" },
        }),
        env,
        {}
      );
      const expected = markdownVariantUrl(path, routes);
      if (expected === null) {
        expect(calls.assets).toStrictEqual([]);
        expect(calls.server.length).toBe(1);
      } else {
        const url = new URL(calls.assets[0] ?? "");
        expect(url.pathname + url.search).toBe(expected);
      }
    }
  });

  it("honors deployment.base like the dev middleware", async () => {
    const worker = await loadWorker(workerText({ base: "/site/" }));
    const routes = new Set(ROUTES);
    for (const path of [
      "/site/docs/quickstart/",
      "/site",
      "/docs/quickstart/",
    ]) {
      const { calls, env } = makeEnv();
      // oxlint-disable-next-line no-await-in-loop -- sequential vectors
      await worker.fetch(
        new Request(`https://site.test${path}`, {
          headers: { accept: "text/markdown" },
        }),
        env,
        {}
      );
      const expected = markdownVariantUrl(path, routes, "/site/");
      if (expected === null) {
        expect(calls.assets).toStrictEqual([]);
      } else {
        const url = new URL(calls.assets[0] ?? "");
        expect(url.pathname + url.search).toBe(expected);
      }
    }
  });
});

describe("negotiation worker — responses", () => {
  it("serves the .md mirror with charset, Vary, and home headers", async () => {
    const worker = await loadWorker(workerText());
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://site.test/", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    // `_headers` does not apply on worker-first routes, so the wrapper itself
    // re-pins the charset and stamps the discovery headers.
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("link")).toBe(HOME_LINK);
    expect(response.headers.get("x-markdown-tokens")).toBe("123");
    expect(await response.text()).toBe("# markdown");
  });

  it("keeps home headers off non-home mirrors", async () => {
    const worker = await loadWorker(workerText());
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://site.test/docs/quickstart/", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    expect(response.headers.get("link")).toBeNull();
    expect(response.headers.get("x-markdown-tokens")).toBeNull();
  });

  it("stamps Vary and the home Link header on the HTML side", async () => {
    const worker = await loadWorker(workerText());
    const { calls, env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://site.test/", { headers: { accept: "text/html" } }),
      env,
      {}
    );
    expect(calls.server.length).toBe(1);
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("link")).toBe(HOME_LINK);
    expect(response.headers.get("content-type")).toBe("text/html");
  });

  it("keeps a Link header the Astro Worker already set", async () => {
    const worker = await loadWorker(workerText());
    const { env } = makeEnv({
      serverResponse: () =>
        new Response("<html>", { headers: { link: "<upstream>" } }),
    });
    const response = await worker.fetch(
      new Request("https://site.test/"),
      env,
      {}
    );
    expect(response.headers.get("link")).toBe("<upstream>");
  });

  it("passes non-content routes and non-GET requests straight through", async () => {
    const worker = await loadWorker(workerText());
    const untouched = new Response("ok");
    const { calls, env } = makeEnv({ serverResponse: () => untouched });
    const passthrough = await worker.fetch(
      new Request("https://site.test/mcp", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    // Identity, not a copy: untouched requests skip the header rewrite.
    expect(passthrough).toBe(untouched);
    await worker.fetch(
      new Request("https://site.test/docs/quickstart/", {
        headers: { accept: "text/markdown" },
        method: "POST",
      }),
      env,
      {}
    );
    expect(calls.assets).toStrictEqual([]);
    expect(calls.server.length).toBe(2);
  });

  it("falls back to the Astro Worker when the mirror asset is missing", async () => {
    const worker = await loadWorker(workerText());
    const { calls, env } = makeEnv({ assetsStatus: 404 });
    const response = await worker.fetch(
      new Request("https://site.test/docs/quickstart/", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    expect(calls.assets.length).toBe(1);
    expect(calls.server.length).toBe(1);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("vary")).toBe("Accept");
  });

  it("omits home headers when no Link header or token count is configured", async () => {
    const worker = await loadWorker(
      workerText({ homeLinkHeader: null, homeTokens: undefined })
    );
    const { env } = makeEnv();
    const negotiated = await worker.fetch(
      new Request("https://site.test/", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    expect(negotiated.headers.get("link")).toBeNull();
    expect(negotiated.headers.get("x-markdown-tokens")).toBeNull();
    const untouched = new Response("<html>");
    const html = makeEnv({ serverResponse: () => untouched });
    const response = await worker.fetch(
      new Request("https://site.test/not-a-route/"),
      html.env,
      {}
    );
    expect(response).toBe(untouched);
  });

  it("skips negotiation when the assets binding is absent", async () => {
    const worker = await loadWorker(workerText({ assetsBinding: "FILES" }));
    const { calls, env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://site.test/docs/quickstart/", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    expect(calls.server.length).toBe(1);
    expect(response.headers.get("vary")).toBe("Accept");
  });
});

describe("negotiation worker — configured redirects", () => {
  /**
   * Configured redirects keep their status only in `_redirects`, which only
   * Cloudflare's static layer reads — a worker-first route never reaches it,
   * and Astro's SSR handler would default a GET to a permanent 301 (its
   * destination never resolves to a discrete route under `[...slug]`). The
   * wrapper answers from its baked-in table instead, so a worker-first claim
   * cannot degrade the configured status.
   */
  it("answers a configured redirect with its exact status", async () => {
    const worker = await loadWorker(workerText({ redirects: REDIRECTS }));
    const { calls, env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://site.test/docs/api", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/docs/api-reference");
    // Neither the Astro Worker nor the assets binding is consulted.
    expect(calls.server).toStrictEqual([]);
    expect(calls.assets).toStrictEqual([]);
  });

  it("matches the trailing-slash spelling and percent-encoded paths", async () => {
    const worker = await loadWorker(workerText({ redirects: REDIRECTS }));
    const slashed = await worker.fetch(
      new Request("https://site.test/docs/api/"),
      makeEnv().env,
      {}
    );
    expect(slashed.status).toBe(302);
    const encoded = await worker.fetch(
      new Request("https://site.test/ja/%E5%8F%A4%E3%81%84"),
      makeEnv().env,
      {}
    );
    expect(encoded.status).toBe(307);
    // The destination is percent-encoded at generation time — a `Location`
    // header cannot carry non-ASCII.
    expect(encoded.headers.get("location")).toBe(
      "/ja/%E6%96%B0%E3%81%97%E3%81%84"
    );
  });

  it("forwards the request query string, like the static layer", async () => {
    // `_redirects` preserves the incoming query string, so a site adopting
    // the baked-in table must not strip attribution parameters (#175).
    const worker = await loadWorker(workerText({ redirects: REDIRECTS }));
    const response = await worker.fetch(
      new Request("https://site.test/docs/api?utm_source=x&ref=y"),
      makeEnv().env,
      {}
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/docs/api-reference?utm_source=x&ref=y"
    );
  });

  it("lets a destination's own query string win over the request's", async () => {
    const worker = await loadWorker(
      workerText({
        redirects: [
          { from: "/docs/old-search", status: 302, to: "/docs/search?tab=all" },
        ],
      })
    );
    const response = await worker.fetch(
      new Request("https://site.test/docs/old-search?utm_source=x"),
      makeEnv().env,
      {}
    );
    expect(response.headers.get("location")).toBe("/docs/search?tab=all");
  });

  it("inserts the query string before a destination fragment", async () => {
    // A fragment must stay last in the URL; appending the query after it
    // would bury the parameters inside the fragment.
    const worker = await loadWorker(
      workerText({
        redirects: [
          {
            from: "/docs/install",
            status: 302,
            to: "/docs/quickstart#install",
          },
        ],
      })
    );
    const withQuery = await worker.fetch(
      new Request("https://site.test/docs/install?ref=a"),
      makeEnv().env,
      {}
    );
    expect(withQuery.headers.get("location")).toBe(
      "/docs/quickstart?ref=a#install"
    );
    const bare = await worker.fetch(
      new Request("https://site.test/docs/install"),
      makeEnv().env,
      {}
    );
    expect(bare.headers.get("location")).toBe("/docs/quickstart#install");
  });

  it("applies redirects to every method, like the static layer", async () => {
    const worker = await loadWorker(workerText({ redirects: REDIRECTS }));
    const { calls, env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://site.test/docs/api", { method: "POST" }),
      env,
      {}
    );
    expect(response.status).toBe(302);
    expect(calls.server).toStrictEqual([]);
  });

  it("leaves non-redirect paths on the normal negotiation path", async () => {
    const worker = await loadWorker(workerText({ redirects: REDIRECTS }));
    const { calls, env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://site.test/docs/quickstart/", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(calls.assets.length).toBe(1);
  });
});

describe("buildRunWorkerFirstRules", () => {
  it("groups routes by first segment with .md/.mdx exemptions", () => {
    expect(buildRunWorkerFirstRules(ROUTES)).toStrictEqual([
      "/",
      "/docs/*",
      "/changelog",
      "/changelog/",
      "/ja/*",
      "!/docs/*.md",
      "!/docs/*.mdx",
      "!/ja/*.md",
      "!/ja/*.mdx",
    ]);
  });

  it("emits both request spellings for a bare route inside a nested group", () => {
    expect(buildRunWorkerFirstRules(["/docs", "/docs/a"])).toStrictEqual([
      "/docs",
      "/docs/*",
      "!/docs/*.md",
      "!/docs/*.mdx",
    ]);
  });

  it("percent-encodes non-ASCII segments", () => {
    expect(buildRunWorkerFirstRules(["/はじめに"])).toStrictEqual([
      "/%E3%81%AF%E3%81%98%E3%82%81%E3%81%AB",
      "/%E3%81%AF%E3%81%98%E3%82%81%E3%81%AB/",
    ]);
  });

  it("routes the whole base as one group on a subpath deploy", () => {
    expect(buildRunWorkerFirstRules(["/", "/docs/a"], "/site/")).toStrictEqual([
      "/site",
      "/site/*",
      "!/site/*.md",
      "!/site/*.mdx",
      "!/site/*.txt",
      "!/site/_astro/*",
    ]);
  });
});

describe("mergeRunWorkerFirstRules", () => {
  it("keeps a user-configured `true` as-is", () => {
    expect(mergeRunWorkerFirstRules(true, ["/docs/*"])).toBe(true);
  });

  it("unions user rules with the generated ones, dropping duplicates", () => {
    expect(
      mergeRunWorkerFirstRules(["/api/*", "/docs/*"], ["/docs/*", "/"])
    ).toStrictEqual(["/api/*", "/docs/*", "/"]);
  });

  it("drops rules a same-polarity glob makes redundant", () => {
    // Wrangler *rejects* redundant rules, so coverage must remove them.
    expect(
      mergeRunWorkerFirstRules(
        ["/docs/getting-started", "!/docs/*"],
        ["/docs/*", "!/docs/*.md"]
      )
    ).toStrictEqual(["!/docs/*", "/docs/*"]);
    // A negative glob never swallows a positive rule, and vice versa.
    expect(mergeRunWorkerFirstRules(["!/x/*"], ["/x/a"])).toStrictEqual([
      "!/x/*",
      "/x/a",
    ]);
  });

  it("ignores non-string entries in a user array", () => {
    expect(mergeRunWorkerFirstRules(["/a", 7, null], ["/b"])).toStrictEqual([
      "/a",
      "/b",
    ]);
  });
});

describe("injectWorkerNegotiation", () => {
  it("swaps main for the wrapper and scopes run_worker_first to content routes", () => {
    const result = injectWorkerNegotiation(wranglerConfig(), {
      homeLinkHeader: HOME_LINK,
      homeTokens: 123,
      routePaths: ROUTES,
    });
    expect(result).not.toBeNull();
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.main).toBe(NEGOTIATION_WORKER_FILE);
    expect(config.assets.run_worker_first).toStrictEqual(
      buildRunWorkerFirstRules(ROUTES)
    );
    // Everything else in the adapter's config rides along untouched.
    expect(config.no_bundle).toBe(true);
    expect(config.assets.directory).toBe("../client");
    expect(result?.worker).toContain('import server from "./index.js"');
  });

  it("merges with user-configured run_worker_first rules", () => {
    const result = injectWorkerNegotiation(
      wranglerConfig({
        assets: {
          binding: "ASSETS",
          directory: "../client",
          run_worker_first: ["/api/*"],
        },
      }),
      { routePaths: ["/", "/docs/a"] }
    );
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.assets.run_worker_first).toStrictEqual([
      "/api/*",
      "/",
      "/docs/*",
      "!/docs/*.md",
      "!/docs/*.mdx",
    ]);
  });

  it("leaves a user-configured `run_worker_first: true` in place", () => {
    const result = injectWorkerNegotiation(
      wranglerConfig({
        assets: {
          binding: "ASSETS",
          directory: "../client",
          run_worker_first: true,
        },
      }),
      { routePaths: ["/"] }
    );
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.assets.run_worker_first).toBe(true);
    expect(config.main).toBe(NEGOTIATION_WORKER_FILE);
  });

  it("falls back to coarse rules when the grouped set exceeds Wrangler's limits", () => {
    const many = Array.from({ length: 80 }, (_, i) => `/page-${i}`);
    const result = injectWorkerNegotiation(wranglerConfig(), {
      routePaths: many,
    });
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.assets.run_worker_first).toStrictEqual([
      "/*",
      "!/_astro/*",
      "!/*.md",
      "!/*.mdx",
      "!/*.txt",
    ]);
  });

  it("falls back when a grouped rule exceeds the per-rule length limit", () => {
    const result = injectWorkerNegotiation(wranglerConfig(), {
      routePaths: [`/${"a".repeat(120)}`],
    });
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.assets.run_worker_first).toStrictEqual([
      "/*",
      "!/_astro/*",
      "!/*.md",
      "!/*.mdx",
      "!/*.txt",
    ]);
  });

  it("bakes configured redirects into the wrapper instead of spending rules", () => {
    const result = injectWorkerNegotiation(wranglerConfig(), {
      redirects: [
        ...REDIRECTS,
        // Not a served path; never baked.
        { from: "not-a-path", status: 302, to: "/docs" },
      ],
      routePaths: ["/", "/docs/reference"],
    });
    const config = JSON.parse(result?.wrangler ?? "");
    // The worker-first rules are untouched — the table costs no rule budget,
    // so redirects can never push the set over Wrangler's limits.
    expect(config.assets.run_worker_first).toStrictEqual(
      buildRunWorkerFirstRules(["/", "/docs/reference"])
    );
    expect(result?.worker).toContain('"/docs/api":["/docs/api-reference",302]');
    expect(result?.worker).not.toContain("not-a-path");
  });

  it("never bakes a redirect at a content route's own path", () => {
    // A page and a redirect cannot both own a path; the page wins, since
    // answering a redirect there would take a real page off the air.
    const result = injectWorkerNegotiation(wranglerConfig(), {
      redirects: [{ from: "/docs/reference", status: 302, to: "/docs" }],
      routePaths: ["/", "/docs/reference"],
    });
    expect(result?.worker).toContain("const REDIRECTS = {};");
  });

  it("bakes a root redirect when the homepage mirror is synthesized", () => {
    // `routePaths` always carries `/` for the llms.txt mirror; only the
    // manifest routes guard the table, so a docs-only site can still redirect
    // its root with the configured status.
    const result = injectWorkerNegotiation(wranglerConfig(), {
      contentRoutePaths: ["/docs/reference"],
      redirects: [{ from: "/", status: 302, to: "/docs/reference" }],
      routePaths: ["/", "/docs/reference"],
    });
    expect(result?.worker).toContain('"/":["/docs/reference",302]');
  });

  it("guards content routes with the deployment base applied", () => {
    // Redirect `from`s carry the full `{deployment.base}{basePath}` stack
    // while the routes carry only `basePath`, so the guard bases the routes
    // before comparing: a redirect at a page's own served URL is dropped, one
    // at a retired URL is kept.
    const result = injectWorkerNegotiation(wranglerConfig(), {
      base: "/site/",
      redirects: [
        { from: "/site/docs/api", status: 302, to: "/site/docs" },
        { from: "/site/docs/api/live", status: 302, to: "/site/docs" },
      ],
      routePaths: ["/", "/docs/api/live"],
    });
    expect(result?.worker).toContain('"/site/docs/api":["/site/docs",302]');
    expect(result?.worker).not.toContain('"/site/docs/api/live"');
  });

  it("returns null when even the fallback cannot fit", () => {
    const negatives = Array.from({ length: 120 }, (_, i) => `!/keep-${i}`);
    expect(
      injectWorkerNegotiation(
        wranglerConfig({
          assets: {
            binding: "ASSETS",
            directory: "../client",
            run_worker_first: negatives,
          },
        }),
        { routePaths: ["/"] }
      )
    ).toBeNull();
  });

  it("returns null when there is nothing to do or nowhere safe to do it", () => {
    expect(injectWorkerNegotiation(wranglerConfig(), { routePaths: [] })).toBe(
      null
    );
    expect(injectWorkerNegotiation("not json", { routePaths: ["/"] })).toBe(
      null
    );
    expect(injectWorkerNegotiation("[]", { routePaths: ["/"] })).toBe(null);
    expect(injectWorkerNegotiation("null", { routePaths: ["/"] })).toBe(null);
    expect(
      injectWorkerNegotiation(wranglerConfig({ main: undefined }), {
        routePaths: ["/"],
      })
    ).toBe(null);
    expect(
      injectWorkerNegotiation(
        wranglerConfig({ main: NEGOTIATION_WORKER_FILE }),
        { routePaths: ["/"] }
      )
    ).toBe(null);
    expect(
      injectWorkerNegotiation(wranglerConfig({ assets: undefined }), {
        routePaths: ["/"],
      })
    ).toBe(null);
    expect(
      injectWorkerNegotiation(
        wranglerConfig({ assets: { directory: "../client" } }),
        { routePaths: ["/"] }
      )
    ).toBe(null);
  });

  it("prefixes a bare main with ./ in the wrapper import", () => {
    const nested = injectWorkerNegotiation(
      wranglerConfig({ main: "entry/worker.js" }),
      { routePaths: ["/"] }
    );
    expect(nested?.worker).toContain('import server from "./entry/worker.js"');
    const relative = injectWorkerNegotiation(
      wranglerConfig({ main: "../server/index.js" }),
      { routePaths: ["/"] }
    );
    expect(relative?.worker).toContain(
      'import server from "../server/index.js"'
    );
  });
});
