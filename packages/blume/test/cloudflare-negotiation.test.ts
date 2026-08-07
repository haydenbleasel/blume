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
 * Served paths of configured redirects, as `deploy/redirects.ts` bases them for
 * a host platform file: the retired `/docs/api` section of a site whose content
 * lives under `basePath: "/docs"`.
 */
const REDIRECTS = ["/docs/api", "/docs/api/get-trace", "/docs/api/run-query"];

/** The adapter-shaped `dist/server/wrangler.json` the injection rewrites. */
const wranglerConfig = (overrides: Record<string, unknown> = {}): string =>
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

interface WorkerModule {
  fetch: (
    request: Request,
    env: unknown,
    context: unknown
  ) => Promise<Response>;
}

/** Write the wrapper (and the stub it imports) to a temp dir and import it. */
const loadWorker = async (workerText: string): Promise<WorkerModule> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-cf-negotiation-"));
  await writeFile(join(dir, "index.js"), SERVER_STUB, "utf-8");
  const file = join(dir, NEGOTIATION_WORKER_FILE);
  await writeFile(file, workerText, "utf-8");
  const loaded = (await import(pathToFileURL(file).href)) as {
    default: WorkerModule;
  };
  return loaded.default;
};

interface HarnessCalls {
  assets: string[];
  server: string[];
}

const makeEnv = (
  options: { assetsStatus?: number; serverResponse?: () => Response } = {}
): { calls: HarnessCalls; env: Record<string, unknown> } => {
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

  /**
   * A configured redirect keeps its status only on Cloudflare's static layer,
   * which reads the `_redirects` the adapter writes from Astro's `redirects`.
   * Inside `run_worker_first` that layer never runs: the Worker answers, and
   * Astro's SSR redirect handler defaults a GET to 301 unless the destination
   * resolves to a discrete route — which it never does here, because Blume
   * serves every page from `[...slug]`. So a redirect swallowed by a content
   * group ships the user's 302 as a permanent 301. Exempting it is the fix.
   */
  it("exempts a redirect swallowed by a content group", () => {
    expect(
      buildRunWorkerFirstRules(["/", "/docs/reference"], undefined, [
        "/docs/api",
      ])
    ).toStrictEqual([
      "/",
      "/docs/*",
      "!/docs/*.md",
      "!/docs/*.mdx",
      "!/docs/api",
      "!/docs/api/",
    ]);
  });

  it("collapses a nested redirect family into one glob", () => {
    // Wrangler rejects a rule another glob makes redundant, so the collapsed
    // form pairs `!/docs/api` with `!/docs/api/*` and drops the members —
    // exactly two rules however many URLs the retired section had.
    expect(
      buildRunWorkerFirstRules(["/", "/docs/reference"], undefined, REDIRECTS)
    ).toStrictEqual([
      "/",
      "/docs/*",
      "!/docs/*.md",
      "!/docs/*.mdx",
      "!/docs/api",
      "!/docs/api/*",
    ]);
  });

  it("does not collapse over a content route living under the redirect", () => {
    // `/docs/api/*` would take `/docs/api/live` off the Worker and break its
    // Markdown negotiation, so the members stay spelled out.
    expect(
      buildRunWorkerFirstRules(["/", "/docs/api/live"], undefined, [
        "/docs/api",
        "/docs/api/run-query",
      ])
    ).toStrictEqual([
      "/",
      "/docs/*",
      "!/docs/*.md",
      "!/docs/*.mdx",
      "!/docs/api",
      "!/docs/api/",
      "!/docs/api/run-query",
      "!/docs/api/run-query/",
    ]);
  });

  it("ignores a redirect no generated rule would have claimed", () => {
    // `/github` is already on the static layer: a rule for it would be noise,
    // and every rule spent here counts against Wrangler's cap of 100.
    expect(
      buildRunWorkerFirstRules(["/", "/docs/reference"], undefined, ["/github"])
    ).toStrictEqual(["/", "/docs/*", "!/docs/*.md", "!/docs/*.mdx"]);
  });

  it("never exempts a path that is also a content route", () => {
    // A page and a redirect cannot both own a path; the page wins, since
    // exempting it would silently disable negotiation for a real route.
    expect(
      buildRunWorkerFirstRules(["/", "/docs/reference"], undefined, [
        "/docs/reference",
      ])
    ).toStrictEqual(["/", "/docs/*", "!/docs/*.md", "!/docs/*.mdx"]);
  });

  it("exempts redirects under the base on a subpath deploy", () => {
    expect(
      buildRunWorkerFirstRules(["/", "/docs/a"], "/site/", [
        "/site/docs/api",
        "/site/docs/api/run-query",
      ])
    ).toStrictEqual([
      "/site",
      "/site/*",
      "!/site/*.md",
      "!/site/*.mdx",
      "!/site/*.txt",
      "!/site/_astro/*",
      "!/site/docs/api",
      "!/site/docs/api/*",
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

  it("exempts configured redirects from the worker-first rules", () => {
    const result = injectWorkerNegotiation(wranglerConfig(), {
      redirectPaths: REDIRECTS,
      routePaths: ["/", "/docs/reference"],
    });
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.assets.run_worker_first).toStrictEqual([
      "/",
      "/docs/*",
      "!/docs/*.md",
      "!/docs/*.mdx",
      "!/docs/api",
      "!/docs/api/*",
    ]);
    // Wrangler rejects a set with no positive rule, so one must always survive.
    expect(
      config.assets.run_worker_first.some(
        (rule: string) => !rule.startsWith("!")
      )
    ).toBe(true);
  });

  it("keeps redirect exemptions when falling back to the coarse rules", () => {
    // `/*` claims every path, so the exemptions matter more here, not less:
    // without them every configured redirect would lose its status.
    const result = injectWorkerNegotiation(wranglerConfig(), {
      redirectPaths: ["/docs/api"],
      routePaths: Array.from({ length: 80 }, (_, i) => `/page-${i}`),
    });
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.assets.run_worker_first).toStrictEqual([
      "/*",
      "!/_astro/*",
      "!/*.md",
      "!/*.mdx",
      "!/*.txt",
      "!/docs/api",
      "!/docs/api/",
    ]);
  });

  it("skips the negotiation when the exemptions cannot fit", () => {
    // Correct redirect statuses outrank negotiation: returning null leaves
    // `run_worker_first` unset, so the static layer serves every redirect with
    // the configured status and the raw `.md` URLs stay reachable directly.
    const many = Array.from({ length: 60 }, (_, i) => `/docs/gone-${i}`);
    expect(
      injectWorkerNegotiation(wranglerConfig(), {
        redirectPaths: many,
        routePaths: ["/", "/docs/reference"],
      })
    ).toBeNull();
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
