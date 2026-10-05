import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import { pageJsonPath } from "../src/ai/api/paths.ts";
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

/** The header Blume's runtime middleware sets on a rendered response. */
const NAMED = { "x-powered-by": "Blume" };

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
  /** Every request the wrapper handed the assets binding, in order. */
  assetRequests: Request[];
  /** The URLs of `assetRequests`. */
  readonly assets: string[];
  server: string[];
}

interface Harness {
  calls: HarnessCalls;
  env: WorkerEnv;
}

const makeEnv = (
  options: { assetsStatus?: number; serverResponse?: () => Response } = {}
): Harness => {
  const assetRequests: Request[] = [];
  const calls: HarnessCalls = {
    assetRequests,
    get assets(): string[] {
      return assetRequests.map((request) => request.url);
    },
    server: [],
  };
  return {
    calls,
    env: {
      ASSETS: {
        fetch: (request: Request): Promise<Response> => {
          assetRequests.push(request);
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
    pageJsonPaths: ROUTES.map(pageJsonPath),
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

/** X-Powered-By on each kind of answer the wrapper gives. */
const poweredByAnswers = async (
  overrides: Partial<Parameters<typeof buildNegotiationWorker>[0]>
): Promise<(string | null)[]> => {
  const worker = await loadWorker(
    workerText({
      redirects: [{ from: "/docs/old", status: 302, to: "/docs/new" }],
      ...overrides,
    })
  );
  const { env } = makeEnv();
  const answers = await Promise.all(
    [
      new Request("https://site.test/docs/old"),
      new Request("https://site.test/api/docs/pages/docs/quickstart.json"),
      new Request("https://site.test/docs/quickstart", {
        headers: { accept: "text/markdown" },
      }),
      new Request("https://site.test/docs/quickstart"),
      new Request("https://site.test/mcp", { method: "POST" }),
    ].map((request) => worker.fetch(request, env, {}))
  );
  return answers.map((answer) => answer.headers.get("x-powered-by"));
};

describe("negotiation worker — responses", () => {
  it("names Blume on every answer unless poweredBy is false", async () => {
    // A redirect, page JSON, a Markdown mirror, a page, and a POST.
    expect(await poweredByAnswers({})).toStrictEqual(
      Array.from({ length: 5 }, () => "Blume")
    );
    expect(await poweredByAnswers({ poweredBy: false })).toStrictEqual(
      Array.from({ length: 5 }, () => null)
    );
  });

  it("keeps an X-Powered-By the response already carries", async () => {
    const worker = await loadWorker(workerText());
    const own = new Response("<html>", {
      headers: { "x-powered-by": "Acme Docs" },
    });
    const { env } = makeEnv({ serverResponse: () => own });
    const response = await worker.fetch(
      new Request("https://site.test/docs/quickstart"),
      env,
      {}
    );
    expect(response.headers.get("x-powered-by")).toBe("Acme Docs");
  });

  it("serves known prerendered page JSON before Astro's API catch-all", async () => {
    const worker = await loadWorker(workerText({ base: "/site/" }));
    const { calls, env } = makeEnv();
    const response = await worker.fetch(
      new Request(
        "https://site.test/site/api/docs/pages/docs/quickstart.json?view=agent",
        {
          headers: { authorization: "Bearer test" },
          method: "HEAD",
        }
      ),
      env,
      {}
    );
    expect(calls.assets).toStrictEqual([
      "https://site.test/site/api/docs/pages/docs/quickstart.json?view=agent",
    ]);
    expect(calls.server).toStrictEqual([]);
    expect(calls.assetRequests[0]?.method).toBe("HEAD");
    expect(calls.assetRequests[0]?.headers.get("authorization")).toBe(
      "Bearer test"
    );
    expect(response.status).toBe(200);
  });

  it("recognizes the home and percent-encoded page JSON assets", async () => {
    const worker = await loadWorker(workerText());
    for (const path of [
      "/api/docs/pages/index.json",
      "/api/docs/pages/ja/%E3%81%AF%E3%81%98%E3%82%81%E3%81%AB.json",
    ]) {
      const { calls, env } = makeEnv();
      // oxlint-disable-next-line no-await-in-loop -- sequential vectors
      await worker.fetch(new Request(`https://site.test${path}`), env, {});
      expect(calls.assets).toStrictEqual([`https://site.test${path}`]);
      expect(calls.server).toStrictEqual([]);
    }
  });

  it("returns a conditional revalidation of a known page JSON asset", async () => {
    // Cloudflare's static assets carry an ETag, so a client revalidating gets
    // a 304 from the binding; that is the document's answer, not a miss.
    const worker = await loadWorker(workerText());
    const { calls, env } = makeEnv({ assetsStatus: 304 });
    const response = await worker.fetch(
      new Request("https://site.test/api/docs/pages/docs/quickstart.json", {
        headers: { "if-none-match": '"etag"' },
      }),
      env,
      {}
    );
    expect(response.status).toBe(304);
    expect(calls.server).toStrictEqual([]);
  });

  it("keeps page JSON the build never emitted on the Astro Worker", async () => {
    // Only the baked set is probed: a route without a JSON twin (a hidden
    // page) stays on the catch-all's problem document even though it is a
    // content route, and so does a path outside the API.
    const worker = await loadWorker(
      workerText({ pageJsonPaths: [pageJsonPath("/docs/quickstart")] })
    );
    const { calls, env } = makeEnv();
    for (const path of [
      "/api/docs/pages/unknown.json",
      "/api/docs/pages/changelog.json",
      "/api/docs/pages/docs/quickstart.json/",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential vectors
      await worker.fetch(new Request(`https://site.test${path}`), env, {});
    }
    expect(calls.assets).toStrictEqual([]);
    expect(calls.server).toHaveLength(3);
  });

  it("falls back to Astro when a known page JSON asset is missing", async () => {
    const worker = await loadWorker(workerText());
    const { calls, env } = makeEnv({ assetsStatus: 404 });
    await worker.fetch(
      new Request("https://site.test/api/docs/pages/docs/quickstart.json"),
      env,
      {}
    );
    expect(calls.assets).toHaveLength(1);
    expect(calls.server).toHaveLength(1);
  });

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
    // Named by Blume's runtime middleware, as every rendered response is.
    const untouched = new Response("ok", { headers: NAMED });
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
    const untouched = new Response("<html>", { headers: NAMED });
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

/** The HTML 404 shell the Astro Worker answers a missing page with. */
const htmlNotFound = (): Response =>
  new Response("<html>404", {
    headers: { "content-type": "text/html; charset=utf-8" },
    status: 404,
  });

describe("negotiation worker — missing pages", () => {
  /**
   * A request no asset matches always reaches the Worker, and the Astro
   * Worker answers it with the HTML 404 shell from the binding. The wrapper
   * swaps that shell for the prerendered Markdown or JSON twin when the client
   * prefers one — the counterpart of the Vercel miss-phase routes.
   */
  const NOT_FOUND = { json: true, markdown: true };

  it("swaps the HTML shell for the Markdown twin when the client prefers Markdown", async () => {
    const worker = await loadWorker(workerText({ notFound: NOT_FOUND }));
    const { calls, env } = makeEnv({ serverResponse: htmlNotFound });
    const response = await worker.fetch(
      new Request("https://site.test/some-path-that-does-not-exist", {
        headers: { accept: "text/markdown", "if-none-match": '"etag"' },
      }),
      env,
      {}
    );
    expect(calls.server).toHaveLength(1);
    expect(calls.assets).toStrictEqual(["https://site.test/404.md"]);
    // The twin is fetched without the request's conditional headers, so an
    // ETag match cannot turn the 404 into a 304.
    expect(calls.assetRequests[0]?.headers.get("if-none-match")).toBeNull();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(response.headers.get("vary")).toBe("Accept");
    expect(await response.text()).toBe("# markdown");
  });

  it("answers a .md URL no page backs with the Markdown twin, without Vary", async () => {
    const worker = await loadWorker(workerText({ notFound: NOT_FOUND }));
    for (const path of ["/docs/missing.md", "/docs/missing.mdx"]) {
      const { calls, env } = makeEnv({ serverResponse: htmlNotFound });
      // oxlint-disable-next-line no-await-in-loop -- sequential vectors
      const response = await worker.fetch(
        new Request(`https://site.test${path}`, {
          headers: { accept: "*/*" },
          method: "HEAD",
        }),
        env,
        {}
      );
      expect(calls.assets).toStrictEqual(["https://site.test/404.md"]);
      expect(calls.assetRequests[0]?.method).toBe("HEAD");
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(
        "text/markdown; charset=utf-8"
      );
      expect(response.headers.get("vary")).toBeNull();
    }
  });

  it("serves the JSON problem document for a JSON preference or a .json URL", async () => {
    const worker = await loadWorker(workerText({ notFound: NOT_FOUND }));
    const negotiated = makeEnv({ serverResponse: htmlNotFound });
    const json = await worker.fetch(
      new Request("https://site.test/missing", {
        headers: { accept: "application/problem+json" },
      }),
      negotiated.env,
      {}
    );
    expect(negotiated.calls.assets).toStrictEqual([
      "https://site.test/404.json",
    ]);
    expect(json.status).toBe(404);
    expect(json.headers.get("content-type")).toBe(
      "application/problem+json; charset=utf-8"
    );
    expect(json.headers.get("vary")).toBe("Accept");
    const raw = makeEnv({ serverResponse: htmlNotFound });
    const file = await worker.fetch(
      new Request("https://site.test/data/missing.json"),
      raw.env,
      {}
    );
    expect(raw.calls.assets).toStrictEqual(["https://site.test/404.json"]);
    expect(file.status).toBe(404);
    expect(file.headers.get("vary")).toBeNull();
  });

  it("prefers the Markdown twin when a client accepts both", async () => {
    const worker = await loadWorker(workerText({ notFound: NOT_FOUND }));
    const { calls, env } = makeEnv({ serverResponse: htmlNotFound });
    await worker.fetch(
      new Request("https://site.test/missing", {
        headers: { accept: "application/json, text/markdown" },
      }),
      env,
      {}
    );
    expect(calls.assets).toStrictEqual(["https://site.test/404.md"]);
  });

  it("fetches the twin under the deployment base", async () => {
    const worker = await loadWorker(
      workerText({ base: "/site/", notFound: NOT_FOUND })
    );
    const { calls, env } = makeEnv({ serverResponse: htmlNotFound });
    await worker.fetch(
      new Request("https://site.test/site/missing", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    expect(calls.assets).toStrictEqual(["https://site.test/site/404.md"]);
  });

  it("leaves a 404 alone unless it is the HTML shell", async () => {
    // An API endpoint's own problem document is the better answer; so is a
    // found page, whatever the client prefers.
    const worker = await loadWorker(workerText({ notFound: NOT_FOUND }));
    const problem = new Response("{}", {
      headers: { "content-type": "application/problem+json", ...NAMED },
      status: 404,
    });
    const { calls, env } = makeEnv({ serverResponse: () => problem });
    const response = await worker.fetch(
      new Request("https://site.test/api/docs/pages/missing.json", {
        headers: { accept: "text/markdown" },
      }),
      env,
      {}
    );
    expect(response).toBe(problem);
    expect(calls.assets).toStrictEqual([]);
    const found = makeEnv();
    await worker.fetch(
      new Request("https://site.test/not-a-route.md", {
        headers: { accept: "text/markdown" },
      }),
      found.env,
      {}
    );
    expect(found.calls.assets).toStrictEqual([]);
  });

  it("keeps the HTML shell for a client that wants HTML", async () => {
    const worker = await loadWorker(workerText({ notFound: NOT_FOUND }));
    const { calls, env } = makeEnv({ serverResponse: htmlNotFound });
    const response = await worker.fetch(
      new Request("https://site.test/missing", {
        headers: { accept: "text/html,*/*;q=0.8" },
      }),
      env,
      {}
    );
    expect(calls.assets).toStrictEqual([]);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
  });

  it("keeps the HTML shell when the twin was not emitted or is missing", async () => {
    // A project that owns `/404` emits no twins, so nothing is probed; a twin
    // the binding cannot find (or an absent binding) leaves the shell as-is.
    const none = await loadWorker(workerText());
    const unwired = makeEnv({ serverResponse: htmlNotFound });
    const shell = await none.fetch(
      new Request("https://site.test/missing", {
        headers: { accept: "text/markdown" },
      }),
      unwired.env,
      {}
    );
    expect(unwired.calls.assets).toStrictEqual([]);
    expect(shell.status).toBe(404);
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const wired = await loadWorker(workerText({ notFound: NOT_FOUND }));
    const missing = makeEnv({
      assetsStatus: 404,
      serverResponse: htmlNotFound,
    });
    const fallback = await wired.fetch(
      new Request("https://site.test/missing", {
        headers: { accept: "text/markdown" },
      }),
      missing.env,
      {}
    );
    expect(missing.calls.assets).toStrictEqual(["https://site.test/404.md"]);
    expect(fallback.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    const unbound = await loadWorker(
      workerText({ assetsBinding: "FILES", notFound: NOT_FOUND })
    );
    const noBinding = makeEnv({ serverResponse: htmlNotFound });
    const untouched = await unbound.fetch(
      new Request("https://site.test/missing", {
        headers: { accept: "text/markdown" },
      }),
      noBinding.env,
      {}
    );
    expect(noBinding.calls.assets).toStrictEqual([]);
    expect(untouched.status).toBe(404);
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

  it("answers a path a pattern covers, after the exact paths, forwarding the query", async () => {
    const worker = await loadWorker(
      workerText({
        redirects: [
          ...REDIRECTS,
          { from: "/docs/beta/:slug*", status: 308, to: "/docs/v2/:slug*" },
          { from: "/docs/beta/pinned", status: 301, to: "/docs/pinned" },
        ],
      })
    );
    const locate = async (url: string) => {
      const answer = await worker.fetch(new Request(url), makeEnv().env, {});
      return [answer.status, answer.headers.get("location")];
    };
    expect(await locate("https://site.test/docs/beta")).toStrictEqual([
      308,
      "/docs/v2",
    ]);
    expect(
      await locate("https://site.test/docs/beta/a/%C3%BC?ref=x")
    ).toStrictEqual([308, "/docs/v2/a/%C3%BC?ref=x"]);
    expect(await locate("https://site.test/docs/beta/pinned")).toStrictEqual([
      301,
      "/docs/pinned",
    ]);
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

/** The generated rule set on a root deploy. */
const ROOT_RULES = [
  "/*",
  "!/_astro/*",
  "!/*.md",
  "!/*.mdx",
  "!/*.txt",
  "!/.well-known/*",
  "!/404.json",
  "!/agent-readability.json",
  "!/blume-search.json",
  "!/openapi.json",
  "!/api/docs/pages.json",
  "!/api/docs/navigation.json",
];

describe("buildRunWorkerFirstRules", () => {
  it("claims every path except the static files that never negotiate", () => {
    // Under an explicit rule list the platform answers a request outside
    // every rule from the static layer — an asset miss included — so only a
    // set that claims everything lets a missing page reach the Worker. The
    // exemptions are the files whose headers come from `_headers`, which
    // Cloudflare never applies to a Worker response.
    expect(buildRunWorkerFirstRules()).toStrictEqual(ROOT_RULES);
    expect(buildRunWorkerFirstRules("/")).toStrictEqual(ROOT_RULES);
  });

  it("claims JSON under /api so a missing page JSON reaches the API's 404", () => {
    // A negative rule outranks every positive one, so a blanket `*.json`
    // exemption would answer `/api/docs/pages/nope.json` from the static
    // layer (an empty 404) instead of the `PAGE_NOT_FOUND` problem document.
    // Only the JSON Blume writes at fixed paths stays on the static layer.
    const rules = buildRunWorkerFirstRules();
    expect(rules).not.toContain("!/*.json");
    expect(rules.filter((rule) => rule.startsWith("!/api/"))).toStrictEqual([
      "!/api/docs/pages.json",
      "!/api/docs/navigation.json",
    ]);
  });

  it("claims the whole base, in both spellings, on a subpath deploy", () => {
    expect(buildRunWorkerFirstRules("/site/")).toStrictEqual([
      "/site",
      "/site/*",
      "!/site/_astro/*",
      "!/site/*.md",
      "!/site/*.mdx",
      "!/site/*.txt",
      "!/site/.well-known/*",
      "!/site/404.json",
      "!/site/agent-readability.json",
      "!/site/blume-search.json",
      "!/site/openapi.json",
      "!/site/api/docs/pages.json",
      "!/site/api/docs/navigation.json",
    ]);
  });

  it("percent-encodes a non-ASCII base", () => {
    expect(buildRunWorkerFirstRules("/ドキュメント")[1]).toBe(
      "/%E3%83%89%E3%82%AD%E3%83%A5%E3%83%A1%E3%83%B3%E3%83%88/*"
    );
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
  it("swaps main for the wrapper and claims every path with run_worker_first", () => {
    const result = injectWorkerNegotiation(wranglerConfig(), {
      homeLinkHeader: HOME_LINK,
      homeTokens: 123,
      routePaths: ROUTES,
    });
    expect(result).not.toBeNull();
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.main).toBe(NEGOTIATION_WORKER_FILE);
    expect(config.assets.run_worker_first).toStrictEqual(ROOT_RULES);
    // Everything else in the adapter's config rides along untouched.
    expect(config.no_bundle).toBe(true);
    expect(config.assets.directory).toBe("../client");
    expect(result?.worker).toContain('import server from "./index.js"');
  });

  it("bakes the emitted page JSON set into the wrapper", () => {
    // The wrapper probes the assets binding for exactly these paths; with
    // none given (the API off) the set is empty and nothing is probed.
    const baked = injectWorkerNegotiation(wranglerConfig(), {
      pageJsonPaths: ["/api/docs/pages/index.json"],
      routePaths: ["/"],
    });
    expect(baked?.worker).toContain(
      'const PAGE_JSON = new Set(["/api/docs/pages/index.json"]);'
    );
    const none = injectWorkerNegotiation(wranglerConfig(), {
      routePaths: ["/"],
    });
    expect(none?.worker).toContain("const PAGE_JSON = new Set([]);");
  });

  it("bakes which 404 twins the build emitted into the wrapper", () => {
    // Only an emitted twin is ever probed; a project that owns `/404` (no
    // twins) keeps the HTML answer without an assets round-trip.
    const wired = injectWorkerNegotiation(wranglerConfig(), {
      notFound: { markdown: true },
      routePaths: ["/"],
    });
    expect(wired?.worker).toContain(
      'const NOT_FOUND = {"json":false,"markdown":true};'
    );
    const none = injectWorkerNegotiation(wranglerConfig(), {
      routePaths: ["/"],
    });
    expect(none?.worker).toContain(
      'const NOT_FOUND = {"json":false,"markdown":false};'
    );
  });

  it("merges with user-configured run_worker_first rules", () => {
    // A user rule the generated `/*` already covers is dropped (Wrangler
    // rejects redundant rules); an exemption of the user's own is kept.
    const result = injectWorkerNegotiation(
      wranglerConfig({
        assets: {
          binding: "ASSETS",
          directory: "../client",
          run_worker_first: ["/api/*", "!/private/*"],
        },
      }),
      { routePaths: ["/", "/docs/a"] }
    );
    const config = JSON.parse(result?.wrangler ?? "");
    expect(config.assets.run_worker_first).toStrictEqual([
      "!/private/*",
      ...ROOT_RULES,
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
    expect(config.assets.run_worker_first).toStrictEqual(ROOT_RULES);
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

  it("returns null when user rules push the set over Wrangler's limits", () => {
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
