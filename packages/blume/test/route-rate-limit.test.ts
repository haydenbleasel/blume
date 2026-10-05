import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { dirname, join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { node } from "../src/deploy/adapters/index.ts";
import { memory } from "../src/ratelimit/index.ts";
import { eject } from "../src/registry/eject.ts";
import { mixedbread } from "../src/search/adapters/index.ts";

// `rateLimit` covers every server route a reader can call: the assistant, the
// playground's built-in proxy, and Mixedbread search. `blume dev` and
// `blume build` generate those routes into `.blume/`, and `blume eject` writes
// the same ones into the app, so both must check the configured limit.

const PKG_ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const PROXY_ROUTE = "src/blume-openapi/api-proxy.ts";
const SEARCH_ROUTE = "src/pages/api/search.ts";

/**
 * A fresh project with the built-in proxy, Mixedbread search, and a limit of
 * two requests.
 */
const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-route-limit-"));
  dirs.push(root);
  const files = {
    // The descriptors are plain data, so the config inlines their JSON.
    "blume.config.ts": `export default {
  deployment: ${JSON.stringify(node())},
  rateLimit: ${JSON.stringify(memory({ requests: 2 }))},
  reference: [{ kind: "openapi", options: { playground: { proxy: true }, spec: "./openapi.json" }, requiredSecrets: [], runtimeDeps: [] }],
  search: ${JSON.stringify(mixedbread({ storeId: "store_7" }))},
};
`,
    "docs/index.md": "# Home\n",
    "openapi.json": JSON.stringify({
      info: { title: "API", version: "1" },
      openapi: "3.0.0",
      paths: { "/ping": { get: { responses: { "200": {} } } } },
      servers: [{ url: "https://api.example.com" }],
    }),
  };
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

/**
 * One route as `blume dev` and `blume build` generate it into `.blume/`, and
 * as `blume eject` writes it into the app.
 */
const routes = async (
  path: string
): Promise<{ ejected: string; generated: string }> => {
  const scanned = await scanProject(await project(), { mode: "build" });
  await generateRuntime(scanned);
  const ejected = await project();
  await eject(ejected);
  return {
    ejected: readFileSync(join(ejected, path), "utf-8"),
    generated: readFileSync(join(scanned.context.outDir, path), "utf-8"),
  };
};

/** The route handler, as this test calls it. */
type Route = (context: {
  clientAddress: string;
  request: Request;
}) => Promise<Response>;

/**
 * Load a generated route outside Astro: the secret becomes a constant, the
 * Mixedbread SDK an inert stub, and every Blume import a file URL.
 */
const loadRoute = async (source: string, method: string): Promise<Route> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-route-limit-load-"));
  dirs.push(dir);
  const stub = join(dir, "mixedbread.mjs");
  await writeFile(
    stub,
    "export default class Mixedbread { stores = { search: async () => ({ data: [] }) }; }\n"
  );
  const file = join(dir, "route.ts");
  await writeFile(
    file,
    source
      .replace(
        'import { getSecret } from "astro:env/server";',
        'const getSecret = (_name: string) => "test-key";'
      )
      .replace(
        'from "@mixedbread/sdk";',
        `from ${JSON.stringify(pathToFileURL(stub).href)};`
      )
      .replaceAll(/"blume\/(?<path>[^"]+)"/gu, (_match, path: string) =>
        JSON.stringify(pathToFileURL(join(PKG_ROOT, "src", path)).href)
      )
  );
  // SAFETY: the generated route exports its handler under the method's name.
  const route = (await import(file)) as Record<string, Route>;
  const handler = route[method];
  if (!handler) {
    throw new Error(`The generated route exports no ${method} handler.`);
  }
  return handler;
};

/** The statuses of `count` requests from one reader. */
const statuses = async (
  route: Route,
  url: string,
  count: number
): Promise<number[]> => {
  const results: number[] = [];
  for (let sent = 0; sent < count; sent += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, so the counts land in order
    const response = await route({
      clientAddress: "203.0.113.7",
      request: new Request(url, {
        body: JSON.stringify({ query: "install" }),
        method: "POST",
      }),
    });
    results.push(response.status);
  }
  return results;
};

describe("rate limiting in the generated server routes", () => {
  it("limits the playground proxy in dev and build as eject does", async () => {
    const { ejected, generated } = await routes(PROXY_ROUTE);
    expect(generated).toContain(
      'const limited = await rateLimited(limiter, context, "api-proxy");'
    );
    expect(generated).toBe(ejected);
    // A send with no target is a 400, until the limit answers first.
    const proxy = await loadRoute(generated, "ALL");
    expect(
      await statuses(proxy, "https://docs.example/_api-proxy", 3)
    ).toStrictEqual([400, 400, 429]);
  }, 30_000);

  it("limits Mixedbread search in dev and build as eject does", async () => {
    const { ejected, generated } = await routes(SEARCH_ROUTE);
    expect(generated).toContain(
      'const limited = await rateLimited(limiter, context, "search");'
    );
    expect(generated).toBe(ejected);
    const search = await loadRoute(generated, "POST");
    expect(
      await statuses(search, "https://docs.example/api/search", 3)
    ).toStrictEqual([200, 200, 429]);
  }, 30_000);
});
