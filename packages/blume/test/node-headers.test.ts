import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import { node } from "../src/deploy/adapters/index.ts";
import {
  NODE_ASTRO_ENTRY_FILE,
  NODE_ENTRY_FILE,
  nodeEntryWrapper,
  nodeHeaderRules,
  wrapNodeEntry,
} from "../src/deploy/node-headers.ts";
import { nodePlatform } from "../src/deploy/platforms/node.ts";
import type { BuildLog } from "../src/deploy/platforms/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-node-headers-"));
  dirs.push(dir);
  return dir;
};

/** A Node server config with the MCP server (and so the AI catalog) on. */
const SERVER_CONFIG = {
  agents: { mcp: { enabled: true } },
  deployment: node({ base: "/docs", site: "https://docs.example.com" }),
};

const recorder = () => {
  const recorded: Record<keyof BuildLog, string[]> = {
    error: [],
    info: [],
    success: [],
    warn: [],
  };
  const log: BuildLog = {
    error: (message) => recorded.error.push(message),
    info: (message) => recorded.info.push(message),
    success: (message) => recorded.success.push(message),
    warn: (message) => recorded.warn.push(message),
  };
  return { log, recorded };
};

/** The slice of a project `wrapNodeEntry` reads. */
const projectAt = (root: string, input: BlumeConfigInput): BlumeProject =>
  // SAFETY: `wrapNodeEntry` reads only `config` and `context.distDir`/`root`.
  ({
    config: blumeConfigSchema.parse(input),
    context: { root },
  }) as BlumeProject;

// A stand-in for `@astrojs/node`'s entry: it records what the wrapper calls.
const FAKE_ASTRO_ENTRY = `globalThis.__astroEntry = { autostart: process.env.ASTRO_NODE_AUTOSTART, calls: [], listeners: [] };
export const options = { mode: globalThis.__fakeMode ?? "standalone" };
export const handler = (req, res, next) => {
  globalThis.__astroEntry.calls.push({ next, url: req.url });
  return "handled";
};
export const startServer = () => {
  if (globalThis.__fakeNoServer) {
    return {};
  }
  // The adapter's own request listener, then the slice of Node's EventEmitter
  // the wrapper uses to take it over.
  const entries = globalThis.__astroEntry.listeners;
  entries.push({
    event: "request",
    listener: (req) =>
      globalThis.__astroEntry.calls.push({ next: "server", url: req.url }),
  });
  return {
    server: {
      server: {
        listeners: (event) =>
          entries.filter((entry) => entry.event === event).map((entry) => entry.listener),
        on: (event, listener) => entries.push({ event, listener }),
        removeAllListeners: (event) => {
          const kept = entries.filter((entry) => entry.event !== event);
          entries.splice(0, entries.length, ...kept);
        },
      },
    },
  };
};
`;

/** The request and response slices the wrapper touches. */
interface FakeRequest {
  url?: string;
}
interface FakeResponse {
  setHeader: (name: string, value: string) => void;
}

interface FakeEntryState {
  autostart: string | undefined;
  calls: { next: string | undefined; url: string | undefined }[];
  listeners: {
    event: string;
    listener: (req: FakeRequest, res: FakeResponse) => void;
  }[];
}

interface WrapperModule {
  handler: (req: FakeRequest, res: FakeResponse, next?: string) => string;
  options: { mode: string };
}

declare global {
  // oxlint-disable-next-line no-var
  var __astroEntry: FakeEntryState;
  // oxlint-disable-next-line no-var
  var __fakeMode: string;
  // oxlint-disable-next-line no-var
  var __fakeNoServer: boolean | undefined;
}

const state = (): FakeEntryState => globalThis.__astroEntry;

/** A response that records the headers set on it. */
const response = () => {
  const headers: Record<string, string> = {};
  return {
    headers,
    res: {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    },
  };
};

/** Write the wrapper beside the fake entry and import it fresh. */
const importWrapper = async (
  autostart: string | null,
  mode = "standalone",
  poweredBy = true
): Promise<WrapperModule> => {
  const dir = await scratch();
  await writeFile(join(dir, NODE_ASTRO_ENTRY_FILE), FAKE_ASTRO_ENTRY, "utf-8");
  await writeFile(
    join(dir, NODE_ENTRY_FILE),
    nodeEntryWrapper(nodeHeaderRules(blumeConfigSchema.parse(SERVER_CONFIG)), {
      poweredBy,
    }),
    "utf-8"
  );
  const previous = process.env.ASTRO_NODE_AUTOSTART;
  if (autostart === null) {
    delete process.env.ASTRO_NODE_AUTOSTART;
  } else {
    process.env.ASTRO_NODE_AUTOSTART = autostart;
  }
  globalThis.__fakeMode = mode;
  try {
    // SAFETY: the wrapper's exports are the Astro entry contract above.
    return (await import(
      pathToFileURL(join(dir, NODE_ENTRY_FILE)).href
    )) as WrapperModule;
  } finally {
    expect(process.env.ASTRO_NODE_AUTOSTART).toBe(autostart ?? undefined);
    if (previous === undefined) {
      delete process.env.ASTRO_NODE_AUTOSTART;
    } else {
      process.env.ASTRO_NODE_AUTOSTART = previous;
    }
  }
};

describe("nodeHeaderRules", () => {
  it("merges the media type and CORS rules per path, under the base", () => {
    const rules = nodeHeaderRules(
      blumeConfigSchema.parse({
        ...SERVER_CONFIG,
        agents: {
          mcp: { enabled: true },
          webBotAuth: {
            keys: [
              {
                crv: "Ed25519",
                kty: "OKP",
                x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
              },
            ],
          },
        },
      })
    );
    const byPath = Object.fromEntries(
      rules.map((rule) => [rule.path, rule.headers])
    );
    expect(byPath["/docs/.well-known/api-catalog"]).toStrictEqual({
      "Access-Control-Allow-Origin": "*",
      "Content-Type":
        'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    });
    expect(byPath["/docs/.well-known/ai-catalog.json"]).toStrictEqual({
      "Access-Control-Allow-Origin": "*",
    });
    expect(byPath["/docs/.well-known/mcp/server-card.json"]).toStrictEqual({
      "Access-Control-Allow-Origin": "*",
    });
    expect(
      byPath["/docs/.well-known/http-message-signatures-directory"]?.[
        "Content-Type"
      ]
    ).toContain("application/http-message-signatures-directory");
  });

  it("has no discovery-specific rules when none are configured", () => {
    // The JSON API alone puts an API catalog on every default site.
    expect(
      nodeHeaderRules(blumeConfigSchema.parse({ agents: { api: false } }))
    ).toStrictEqual([]);
  });
});

describe("nodeEntryWrapper", () => {
  it("leaves out the powered-by header when disabled", async () => {
    const wrapper = await importWrapper("disabled", "standalone", false);
    const responseWithNoPoweredBy = response();
    wrapper.handler({ url: "/docs/guide" }, responseWithNoPoweredBy.res);
    expect(responseWithNoPoweredBy.headers).toStrictEqual({});
  });

  it("sets a rule's headers, then hands the request to Astro", async () => {
    const wrapper = await importWrapper("disabled");
    expect(wrapper.options).toStrictEqual({ mode: "standalone" });
    // Imported with autostart off, and started nothing on its own.
    expect(state().autostart).toBe("disabled");
    expect(state().listeners).toStrictEqual([]);

    const matched = response();
    expect(
      wrapper.handler(
        { url: "/docs/.well-known/api-catalog?x=1" },
        matched.res,
        "next"
      )
    ).toBe("handled");
    expect(matched.headers).toStrictEqual({
      "Access-Control-Allow-Origin": "*",
      "Content-Type":
        'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
      "X-Powered-By": "Blume",
    });
    expect(state().calls).toStrictEqual([
      { next: "next", url: "/docs/.well-known/api-catalog?x=1" },
    ]);

    const other = response();
    wrapper.handler({ url: "/docs/guide" }, other.res);
    wrapper.handler({}, other.res);
    expect(other.headers).toStrictEqual({ "X-Powered-By": "Blume" });
  });

  it("still starts when the adapter exposes no HTTP server to hook", async () => {
    globalThis.__fakeNoServer = true;
    try {
      await importWrapper(null);
      expect(state().listeners).toStrictEqual([]);
    } finally {
      globalThis.__fakeNoServer = undefined;
    }
  });

  it("starts the server with its listener in front of Astro's when autostart is on", async () => {
    await importWrapper(null);
    // Astro's entry was imported with autostart off either way.
    expect(state().autostart).toBe("disabled");
    // The wrapper's listener replaced Astro's, which it now calls itself.
    const { listeners } = state();
    expect(listeners).toHaveLength(1);
    const [started] = listeners;
    expect(started?.event).toBe("request");
    const served = response();
    started?.listener({ url: "/docs/.well-known/mcp.json" }, served.res);
    expect(served.headers).toStrictEqual({
      "Access-Control-Allow-Origin": "*",
      "X-Powered-By": "Blume",
    });
    expect(state().calls).toStrictEqual([
      { next: "server", url: "/docs/.well-known/mcp.json" },
    ]);
  });

  it("leaves a middleware-mode entry for its host to start", async () => {
    await importWrapper(null, "middleware");
    expect(state().listeners).toStrictEqual([]);
  });
});

describe("wrapNodeEntry", () => {
  it("moves Astro's entry aside and writes the wrapper once", async () => {
    const root = await scratch();
    const serverDir = join(root, "dist", "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, NODE_ENTRY_FILE), "// astro\n", "utf-8");
    const project = projectAt(root, SERVER_CONFIG);

    const first = recorder();
    await wrapNodeEntry(project, first.log);
    expect(
      await readFile(join(serverDir, NODE_ASTRO_ENTRY_FILE), "utf-8")
    ).toBe("// astro\n");
    const wrapper = await readFile(join(serverDir, NODE_ENTRY_FILE), "utf-8");
    expect(wrapper).toContain(`import("./${NODE_ASTRO_ENTRY_FILE}")`);
    expect(first.recorded.success).toHaveLength(1);

    // A second pass over the same output leaves the wrapped entry alone.
    const second = recorder();
    await wrapNodeEntry(project, second.log);
    expect(await readFile(join(serverDir, NODE_ENTRY_FILE), "utf-8")).toBe(
      wrapper
    );
    expect(
      await readFile(join(serverDir, NODE_ASTRO_ENTRY_FILE), "utf-8")
    ).toBe("// astro\n");
    expect(second.recorded.success).toStrictEqual([]);
  });

  it("warns when the build has no Node entry", async () => {
    const root = await scratch();
    const { log, recorded } = recorder();
    await wrapNodeEntry(projectAt(root, SERVER_CONFIG), log);
    expect(recorded.warn[0]).toContain("Could not find the Node server entry");
  });

  it("wraps Astro's entry to add the powered-by response header", async () => {
    const root = await scratch();
    const serverDir = join(root, "dist", "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, NODE_ENTRY_FILE), "// astro\n", "utf-8");
    const { log, recorded } = recorder();
    await wrapNodeEntry(
      projectAt(root, { agents: { api: false }, deployment: node() }),
      log
    );
    expect(await readFile(join(serverDir, NODE_ENTRY_FILE), "utf-8")).toContain(
      'res.setHeader("X-Powered-By", "Blume")'
    );
    expect(recorded.warn).toStrictEqual([]);
  });

  it("sandboxes downloaded SVG assets when the build has them", async () => {
    const root = await scratch();
    const serverDir = join(root, "dist", "server");
    await mkdir(serverDir, { recursive: true });
    await mkdir(join(root, "dist", "client", "blume-assets"), {
      recursive: true,
    });
    await writeFile(
      join(serverDir, NODE_ENTRY_FILE),
      FAKE_ASTRO_ENTRY,
      "utf-8"
    );
    const { log } = recorder();
    // No discovery rule applies, so the asset rule alone brings the wrapper.
    await wrapNodeEntry(
      projectAt(root, { agents: { api: false }, deployment: node() }),
      log
    );
    const wrapper = await readFile(join(serverDir, NODE_ENTRY_FILE), "utf-8");
    expect(wrapper).toContain('["/blume-assets/",".svg"');
    process.env.ASTRO_NODE_AUTOSTART = "disabled";
    try {
      // SAFETY: the wrapper's exports are the Astro entry contract above.
      const module = (await import(
        pathToFileURL(join(serverDir, NODE_ENTRY_FILE)).href
      )) as WrapperModule;
      const svg = response();
      module.handler({ url: "/blume-assets/sanity/abc.svg?v=1" }, svg.res);
      expect(svg.headers).toStrictEqual({
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "X-Powered-By": "Blume",
      });
      const png = response();
      module.handler({ url: "/blume-assets/sanity/abc.png" }, png.res);
      expect(png.headers).toStrictEqual({ "X-Powered-By": "Blume" });
    } finally {
      delete process.env.ASTRO_NODE_AUTOSTART;
    }
  });

  it("runs from the platform on a real build, not an isolated one", async () => {
    const root = await scratch();
    const serverDir = join(root, "dist", "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, NODE_ENTRY_FILE), "// astro\n", "utf-8");
    const project = projectAt(root, SERVER_CONFIG);

    const isolated = recorder();
    expect(
      await nodePlatform.finalizeBuild?.({
        isolated: true,
        log: isolated.log,
        project,
      })
    ).toBe(true);
    expect(await readFile(join(serverDir, NODE_ENTRY_FILE), "utf-8")).toBe(
      "// astro\n"
    );

    const real = recorder();
    expect(
      await nodePlatform.finalizeBuild?.({
        isolated: false,
        log: real.log,
        project,
      })
    ).toBe(true);
    expect(real.recorded.success).toHaveLength(1);
  });
});
