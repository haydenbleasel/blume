import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { dirname, join } from "pathe";

import type { BlumeProject } from "../src/core/project-graph.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { netlify, vercel } from "../src/deploy/adapters/index.ts";
import {
  buildNegotiationWorker,
  NEGOTIATION_WORKER_FILE,
} from "../src/deploy/cloudflare-negotiation.ts";
import {
  buildVercelHeaders,
  headerRules,
  SVG_ASSET_HEADERS,
  svgAssetPath,
} from "../src/deploy/headers.ts";
import {
  NODE_ASTRO_ENTRY_FILE,
  NODE_ENTRY_FILE,
  nodeEntryWrapper,
} from "../src/deploy/node-headers.ts";
import type { BuildLog } from "../src/deploy/platforms/index.ts";
import {
  emitNetlifyHeaders,
  NETLIFY_CONFIG_FILE,
  netlifyPlatform,
} from "../src/deploy/platforms/netlify.ts";
import { emitVercelNegotiation } from "../src/deploy/platforms/vercel.ts";
import { injectNegotiationRoutes } from "../src/deploy/vercel-negotiation.ts";
import type { VercelRoute } from "../src/deploy/vercel-negotiation.ts";

/**
 * The SVGs a content source downloads are served with a sandbox policy and
 * `nosniff` on every host, in static and server builds alike, each through
 * the host's own mechanism: the `_headers`/`vercel.json` rules of a static
 * build, the Vercel routing config, the Netlify Frameworks API config, the
 * Cloudflare wrapper Worker, and the Node entry wrapper.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-svg-sandbox-"));
  dirs.push(dir);
  return dir;
};

const writeTree = async (
  root: string,
  files: Record<string, string>
): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    })
  );
};

/** A scanned project on the given deployment, with extra files on disk. */
const project = async (
  deployment: string,
  files: Record<string, string> = {}
): Promise<BlumeProject> => {
  const root = await scratch();
  await writeTree(root, {
    "blume.config.ts": `export default { deployment: ${deployment} };\n`,
    "docs/index.md": "# Home\n\nWelcome.\n",
    ...files,
  });
  return scanProject(root, { mode: "build" });
};

const recorder = () => {
  const warnings: string[] = [];
  const log: BuildLog = {
    error: () => {},
    info: () => {},
    success: () => {},
    warn: (message) => warnings.push(message),
  };
  return { log, warnings };
};

const SANDBOX = {
  "Content-Security-Policy": "sandbox",
  "X-Content-Type-Options": "nosniff",
};

describe("static hosts", () => {
  it("sandbox the SVGs under the deployment base in _headers and vercel.json", () => {
    const config = blumeConfigSchema.parse({ deployment: { base: "/docs/" } });
    expect(svgAssetPath(config)).toBe("/docs/blume-assets/*.svg");
    expect(
      headerRules(config).filter((rule) => rule.path === svgAssetPath(config))
    ).toStrictEqual([
      {
        name: "Content-Security-Policy",
        path: "/docs/blume-assets/*.svg",
        value: "sandbox",
      },
      {
        name: "X-Content-Type-Options",
        path: "/docs/blume-assets/*.svg",
        value: "nosniff",
      },
    ]);
    expect(
      buildVercelHeaders(config)
        .filter((entry) => entry.source === "/docs/blume-assets/(.*).svg")
        .flatMap((entry) => entry.headers)
    ).toStrictEqual([
      { key: "Content-Security-Policy", value: "sandbox" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ]);
  });
});

/** A Build Output config shaped like the adapter's, filesystem marker and all. */
const VERCEL_CONFIG = JSON.stringify({
  routes: [
    {
      continue: true,
      headers: { "cache-control": "immutable" },
      src: "^/_astro/(.*)$",
    },
    { handle: "filesystem" },
    { dest: "/404.html", src: "/.*", status: 404 },
  ],
  version: 3,
});

const svgRoutes = (configText: string | null): VercelRoute[] =>
  (JSON.parse(configText ?? "{}").routes ?? []).filter(
    (route: VercelRoute) => route.src === String.raw`^/blume-assets/.+\.svg$`
  );

describe("vercel() server builds", () => {
  it("stamp the sandbox from a main-phase route before the filesystem", () => {
    const injected = injectNegotiationRoutes(
      VERCEL_CONFIG,
      [],
      null,
      undefined,
      undefined,
      {},
      [],
      true
    );
    const { routes } = JSON.parse(injected ?? "{}");
    const svgIndex = routes.findIndex(
      (route: VercelRoute) => route.src === String.raw`^/blume-assets/.+\.svg$`
    );
    expect(routes[svgIndex]).toStrictEqual({
      continue: true,
      headers: {
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
      },
      src: String.raw`^/blume-assets/.+\.svg$`,
    });
    // Main phase: a prerendered file is matched by the filesystem handler, so
    // a header route after it would never fire.
    expect(svgIndex).toBeLessThan(
      routes.findIndex((route: VercelRoute) => route.handle === "filesystem")
    );
    // Re-injection replaces the route rather than adding a second.
    const twice = injectNegotiationRoutes(
      injected ?? "",
      [],
      null,
      undefined,
      undefined,
      {},
      [],
      true
    );
    expect(twice).toBe(injected ?? "");
    expect(svgRoutes(injectNegotiationRoutes(VERCEL_CONFIG, []))).toStrictEqual(
      []
    );
  });

  it("wire the route when the build downloaded content assets", async () => {
    const withAssets = await project(JSON.stringify(vercel()), {
      ".vercel/output/config.json": VERCEL_CONFIG,
      ".vercel/output/static/blume-assets/sanity/a.svg": "<svg/>",
    });
    await emitVercelNegotiation(withAssets, recorder().log);
    const configPath = join(
      withAssets.context.root,
      ".vercel",
      "output",
      "config.json"
    );
    expect(svgRoutes(await readFile(configPath, "utf-8"))).toHaveLength(1);

    const without = await project(JSON.stringify(vercel()), {
      ".vercel/output/config.json": VERCEL_CONFIG,
    });
    await emitVercelNegotiation(without, recorder().log);
    expect(
      svgRoutes(
        await readFile(
          join(without.context.root, ".vercel", "output", "config.json"),
          "utf-8"
        )
      )
    ).toStrictEqual([]);
  });
});

/** The Frameworks API config `@astrojs/netlify` writes. */
const NETLIFY_FRAMEWORK_CONFIG = JSON.stringify({
  headers: [
    {
      for: "/_astro/*",
      values: { "Cache-Control": "public, max-age=31536000, immutable" },
    },
  ],
  images: { remote_images: [] },
});

describe("netlify() server builds", () => {
  it("add the sandbox to the Frameworks API config, once", async () => {
    const built = await project(JSON.stringify(netlify({ base: "/docs" })), {
      [NETLIFY_CONFIG_FILE]: NETLIFY_FRAMEWORK_CONFIG,
      "dist/blume-assets/sanity/a.svg": "<svg/>",
    });
    const configPath = join(built.context.root, NETLIFY_CONFIG_FILE);

    // An isolated verify leaves the deploy config alone.
    expect(
      await netlifyPlatform.finalizeBuild?.({
        isolated: true,
        log: recorder().log,
        project: built,
      })
    ).toBe(true);
    expect(await readFile(configPath, "utf-8")).toBe(NETLIFY_FRAMEWORK_CONFIG);

    expect(
      await netlifyPlatform.finalizeBuild?.({
        isolated: false,
        log: recorder().log,
        project: built,
      })
    ).toBe(true);
    const once = await readFile(configPath, "utf-8");
    await emitNetlifyHeaders(built, recorder().log);
    expect(await readFile(configPath, "utf-8")).toBe(once);
    const written: {
      headers: { for: string; values: Record<string, string> }[];
      images: { remote_images: string[] };
    } = JSON.parse(once);
    // The adapter's own rule and keys ride through ahead of Blume's.
    expect(written.headers[0]).toStrictEqual({
      for: "/_astro/*",
      values: { "Cache-Control": "public, max-age=31536000, immutable" },
    });
    expect(written.images).toStrictEqual({ remote_images: [] });
    expect(
      written.headers.filter(
        (entry) => entry.for === "/docs/blume-assets/*.svg"
      )
    ).toStrictEqual([{ for: "/docs/blume-assets/*.svg", values: SANDBOX }]);
  });
});

/** The Astro Worker the wrapper delegates to, answering with an SVG. */
const SERVER_STUB = `export default {
  fetch() {
    return Promise.resolve(
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
    );
  },
};
`;

interface WorkerModule {
  fetch: (
    request: Request,
    env: Record<string, never>,
    context: Record<string, never>
  ) => Promise<Response>;
}

const loadWorker = async (base?: string): Promise<WorkerModule> => {
  const dir = await scratch();
  await writeFile(join(dir, "index.js"), SERVER_STUB, "utf-8");
  const file = join(dir, NEGOTIATION_WORKER_FILE);
  await writeFile(
    file,
    buildNegotiationWorker({
      assetsBinding: "ASSETS",
      base,
      mainSpecifier: "./index.js",
      routePaths: ["/"],
    }),
    "utf-8"
  );
  // SAFETY: the file written above is the generated wrapper Worker, which
  // default-exports a `{ fetch }` module.
  const loaded = (await import(pathToFileURL(file).href)) as {
    default: WorkerModule;
  };
  return loaded.default;
};

const workerHeaders = async (
  worker: WorkerModule,
  path: string,
  method = "GET"
): Promise<Record<string, string>> => {
  const response = await worker.fetch(
    new Request(`https://docs.example.com${path}`, { method }),
    {},
    {}
  );
  return {
    csp: response.headers.get("content-security-policy") ?? "",
    nosniff: response.headers.get("x-content-type-options") ?? "",
  };
};

describe("cloudflare() server builds", () => {
  it("stamp the sandbox in the wrapper Worker, where _headers never applies", async () => {
    const worker = await loadWorker();
    const sandboxed = await Promise.all(
      [
        "/blume-assets/sanity/a.svg",
        "/blume-assets/sanity/a.sv%67",
        "/blume-assets/sanity/a%2Esvg",
        "/blume-assets/sanity/A.SVG?v=1",
      ].map((path) => workerHeaders(worker, path))
    );
    for (const headers of sandboxed) {
      expect(headers).toStrictEqual({ csp: "sandbox", nosniff: "nosniff" });
    }
    // Every method: the check runs before the wrapper hands other methods on.
    expect(
      await workerHeaders(worker, "/blume-assets/a.svg", "POST")
    ).toStrictEqual({ csp: "sandbox", nosniff: "nosniff" });
    const plain = await Promise.all(
      ["/blume-assets/a.png", "/logo.svg"].map((path) =>
        workerHeaders(worker, path)
      )
    );
    for (const headers of plain) {
      expect(headers).toStrictEqual({ csp: "", nosniff: "" });
    }
  });

  it("match the assets under the deployment base", async () => {
    const worker = await loadWorker("/Docs/");
    expect(
      await workerHeaders(worker, "/Docs/blume-assets/sanity/a.svg")
    ).toStrictEqual({ csp: "sandbox", nosniff: "nosniff" });
    expect(await workerHeaders(worker, "/blume-assets/a.svg")).toStrictEqual({
      csp: "",
      nosniff: "",
    });
  });
});

/** A stand-in for `@astrojs/node`'s entry that serves nothing itself. */
const FAKE_ASTRO_ENTRY = `export const options = { mode: "middleware" };
export const handler = () => "handled";
export const startServer = () => ({});
`;

interface NodeWrapper {
  handler: (
    req: { url?: string },
    res: { setHeader: (name: string, value: string) => void }
  ) => string;
}

const loadNodeWrapper = async (base: string): Promise<NodeWrapper> => {
  const dir = await scratch();
  await writeFile(join(dir, NODE_ASTRO_ENTRY_FILE), FAKE_ASTRO_ENTRY, "utf-8");
  await writeFile(
    join(dir, NODE_ENTRY_FILE),
    nodeEntryWrapper(
      [
        {
          headers: { ...SVG_ASSET_HEADERS },
          path: `${base}/blume-assets/*.svg`,
        },
      ],
      // Just the sandbox: node-headers.test.ts covers X-Powered-By.
      { base, poweredBy: false }
    ),
    "utf-8"
  );
  // SAFETY: the wrapper's exports are the Astro entry contract.
  return (await import(
    pathToFileURL(join(dir, NODE_ENTRY_FILE)).href
  )) as NodeWrapper;
};

const nodeHeaders = (wrapper: NodeWrapper, url: string) => {
  const headers: Record<string, string> = {};
  expect(
    wrapper.handler(
      { url },
      {
        setHeader: (name, value) => {
          headers[name] = value;
        },
      }
    )
  ).toBe("handled");
  return headers;
};

describe("node() server builds", () => {
  it("match the file the static handler serves, not the raw URL", async () => {
    const wrapper = await loadNodeWrapper("/docs");
    for (const url of [
      "/docs/blume-assets/sanity/abc.svg",
      // `send` decodes before it picks the file and its MIME type.
      "/docs/blume-assets/sanity/abc.sv%67",
      "/docs/blume-assets/sanity/abc%2Esvg",
      "/docs/blume-assets%2Fsanity%2Fabc.svg",
      // Astro serves a path outside the base from the client dir as well,
      // and normalizes dot segments and doubled slashes.
      "/blume-assets/sanity/abc.svg",
      "/docs/x/../blume-assets/abc.svg",
      "/docs/../blume-assets/abc.svg",
      "//docs//blume-assets/abc.svg?v=1#top",
      // A case-insensitive disk serves this file, and `send` types it by its
      // lowercased extension.
      "/docs/blume-assets/sanity/ABC.SVG",
    ]) {
      expect(nodeHeaders(wrapper, url)).toStrictEqual(SANDBOX);
    }
    for (const url of [
      "/docs/blume-assets/sanity/abc.png",
      "/docs/logo.svg",
      // A malformed escape keeps the raw path, which matches nothing.
      "/docs/blume-assets/%E0%A4%A.png",
      "/docs",
    ]) {
      expect(nodeHeaders(wrapper, url)).toStrictEqual({});
    }
  });

  it("match at the root when no base is set", async () => {
    const wrapper = await loadNodeWrapper("");
    expect(nodeHeaders(wrapper, "/blume-assets/a.sv%67")).toStrictEqual(
      SANDBOX
    );
    expect(nodeHeaders(wrapper, "/docs/blume-assets/a.svg")).toStrictEqual({});
  });
});
