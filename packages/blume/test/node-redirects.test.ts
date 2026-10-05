import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import type { BlumeProject } from "../src/core/project-graph.ts";
import { compileRedirects } from "../src/core/redirect-patterns.ts";
import type { CompiledRedirect } from "../src/core/redirect-patterns.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import { node } from "../src/deploy/adapters/index.ts";
import {
  NODE_ASTRO_ENTRY_FILE,
  NODE_ENTRY_FILE,
  nodeEntryWrapper,
  nodePatternRedirects,
  nodeRedirects,
  wrapNodeEntry,
} from "../src/deploy/node-headers.ts";
import type { NodeRedirects } from "../src/deploy/node-headers.ts";
import type { BuildLog } from "../src/deploy/platforms/types.ts";

/**
 * A `node()` server build answers the configured redirects from its entry
 * wrapper with their exact status. Astro's own handler would send a 301 (a
 * 308 for other methods) for every one of them, because Blume's destinations
 * never resolve to a discrete route.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-node-redirects-"));
  dirs.push(dir);
  return dir;
};

/** The slices of a project the wrapper reads: config, manifest, and root. */
const projectAt = (
  root: string,
  input: BlumeConfigInput,
  routes: string[] = ["/", "/guide"]
): BlumeProject =>
  // SAFETY: `wrapNodeEntry` and `nodeRedirects` read only `config`,
  // `manifest.routes[].path`, and `context.root`.
  ({
    config: blumeConfigSchema.parse(input),
    context: { root },
    manifest: { routes: routes.map((path) => ({ path })) },
  }) as BlumeProject;

const log: BuildLog = {
  error: () => {},
  info: () => {},
  success: () => {},
  warn: () => {},
};

/**
 * A stand-in for `@astrojs/node`'s entry: every request it sees is recorded,
 * and its standalone server is the slice of Node's EventEmitter the wrapper
 * takes over.
 */
const FAKE_ASTRO_ENTRY = `const seen = [];
globalThis.__redirectEntry = { listeners: [], seen };
export const options = { mode: "middleware" };
export const handler = (req) => {
  seen.push(req.url);
  return "handled";
};
export const startServer = () => {
  const entries = globalThis.__redirectEntry.listeners;
  entries.push({ event: "request", listener: (req) => seen.push(req.url) });
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

interface FakeRequest {
  url?: string;
}

interface FakeResponse {
  end: () => void;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
}

interface RedirectEntryState {
  listeners: {
    event: string;
    listener: (req: FakeRequest, res: FakeResponse) => void;
  }[];
  seen: (string | undefined)[];
}

declare global {
  // oxlint-disable-next-line no-var
  var __redirectEntry: RedirectEntryState;
}

interface WrapperModule {
  handler: (req: FakeRequest, res: FakeResponse) => string | undefined;
  startServer: () => void;
}

const loadWrapper = async (
  redirects: NodeRedirects,
  patternRedirects: CompiledRedirect[] = []
): Promise<WrapperModule> => {
  const dir = await scratch();
  await writeFile(join(dir, NODE_ASTRO_ENTRY_FILE), FAKE_ASTRO_ENTRY, "utf-8");
  await writeFile(
    join(dir, NODE_ENTRY_FILE),
    nodeEntryWrapper([], { base: "/docs", patternRedirects, redirects }),
    "utf-8"
  );
  // SAFETY: the wrapper's exports are the Astro entry contract above.
  return (await import(
    pathToFileURL(join(dir, NODE_ENTRY_FILE)).href
  )) as WrapperModule;
};

/** How the wrapper answered a response. */
interface RecordedAnswer {
  ended: boolean;
  headers: Record<string, string>;
  status: number | null;
}

/** A response that records how it was answered. */
const response = () => {
  const answer: RecordedAnswer = { ended: false, headers: {}, status: null };
  const res: FakeResponse = {
    end: () => {
      answer.ended = true;
    },
    setHeader: (name, value) => {
      answer.headers[name] = value;
    },
    writeHead: (status, headers) => {
      answer.status = status;
      Object.assign(answer.headers, headers);
    },
  };
  return { answer, res };
};

const REDIRECTS: NodeRedirects = {
  "/docs/old": ["/docs/new", 302],
  "/docs/ünï": ["/docs/%C3%BC", 307],
};

describe("nodeRedirects", () => {
  it("keys the based redirects by served path, with the exact status", () => {
    const project = projectAt("/tmp/unused", {
      basePath: "/guide",
      deployment: node({ base: "/docs" }),
      redirects: [
        { from: "/old/", status: 302, to: "/new" },
        { from: "/ünï", status: 307, to: "/ü" },
      ],
    });
    expect(nodeRedirects(project)).toStrictEqual({
      "/docs/guide/old": ["/docs/guide/new", 302],
      "/docs/guide/ünï": ["/docs/guide/%C3%BC", 307],
    });
  });

  it("leaves out a redirect at a content route's own path", () => {
    const project = projectAt("/tmp/unused", {
      deployment: node({ base: "/docs" }),
      redirects: [
        { from: "/guide", status: 302, to: "/elsewhere" },
        { from: "/", status: 307, to: "/guide" },
        { from: "/old", status: 308, to: "/guide" },
      ],
    });
    // The moved page's Markdown copies follow it, while `/`, still a page,
    // keeps its own.
    expect(nodeRedirects(project)).toStrictEqual({
      "/docs/old": ["/docs/guide", 308],
      "/docs/old.md": ["/docs/guide.md", 308],
      "/docs/old.mdx": ["/docs/guide.mdx", 308],
    });
  });

  it("has nothing to answer without redirects", () => {
    expect(nodeRedirects(projectAt("/tmp/unused", {}))).toStrictEqual({});
  });
});

describe("the entry wrapper's redirects", () => {
  it("answer a configured redirect with its exact status before Astro", async () => {
    const wrapper = await loadWrapper(REDIRECTS);
    for (const url of ["/docs/old", "/docs/old/", "/docs/old?from=nav"]) {
      const { answer, res } = response();
      expect(wrapper.handler({ url }, res)).toBeUndefined();
      expect(answer).toStrictEqual({
        ended: true,
        headers: { location: "/docs/new" },
        status: 302,
      });
    }
    const encoded = response();
    wrapper.handler({ url: "/docs/%C3%BCn%C3%AF" }, encoded.res);
    expect(encoded.answer.status).toBe(307);
    expect(encoded.answer.headers.location).toBe("/docs/%C3%BC");
    expect(globalThis.__redirectEntry.seen).toStrictEqual([]);

    // Anything else, a malformed escape included, goes to Astro.
    const other = response();
    expect(wrapper.handler({ url: "/docs/new" }, other.res)).toBe("handled");
    wrapper.handler({ url: "/docs/%E0%A4%A" }, response().res);
    wrapper.handler({}, response().res);
    expect(other.answer.status).toBeNull();
    expect(globalThis.__redirectEntry.seen).toStrictEqual([
      "/docs/new",
      "/docs/%E0%A4%A",
      undefined,
    ]);
  });

  it("answer from the standalone server's listener, which Astro's never sees", async () => {
    const wrapper = await loadWrapper(REDIRECTS);
    wrapper.startServer();
    const { listeners, seen } = globalThis.__redirectEntry;
    expect(listeners).toHaveLength(1);
    const [taken] = listeners;
    const redirected = response();
    taken?.listener({ url: "/docs/old" }, redirected.res);
    expect(redirected.answer.status).toBe(302);
    expect(seen).toStrictEqual([]);
    taken?.listener({ url: "/docs/guide" }, response().res);
    expect(seen).toStrictEqual(["/docs/guide"]);
  });
});

describe("the entry wrapper's pattern redirects", () => {
  const PATTERNS = compileRedirects([
    { from: "/docs/beta/:slug*", status: 308, to: "/docs/v2/:slug*" },
    { from: "/docs/old/article-*", status: 302, to: "/docs/new/article-*" },
  ]);

  it("answer a path a pattern covers, after the exact paths", async () => {
    const wrapper = await loadWrapper(
      { "/docs/beta/pinned": ["/docs/pinned", 301] },
      PATTERNS
    );
    const answers = [
      "/docs/beta",
      "/docs/beta/a/b/",
      "/docs/beta/%C3%BC%3F",
      "/docs/old/article-9",
      "/docs/beta/pinned",
    ].map((url) => {
      const { answer, res } = response();
      wrapper.handler({ url }, res);
      return [answer.status, answer.headers.location];
    });
    expect(answers).toStrictEqual([
      [308, "/docs/v2"],
      [308, "/docs/v2/a/b"],
      [308, "/docs/v2/%C3%BC%3F"],
      [302, "/docs/new/article-9"],
      [301, "/docs/pinned"],
    ]);
    expect(wrapper.handler({ url: "/docs/betas" }, response().res)).toBe(
      "handled"
    );
  });
});

describe(nodePatternRedirects, () => {
  it("compiles the based patterns, and nothing without redirects", () => {
    const project = projectAt("/tmp/unused", {
      deployment: node({ base: "/docs" }),
      redirects: [
        { from: "/old", status: 302, to: "/new" },
        { from: "/beta/:slug*", status: 302, to: "/v2/:slug*" },
      ],
    });
    expect(nodePatternRedirects(project)).toStrictEqual([
      ["^/docs/beta/?$", "/docs/v2", 302],
      ["^/docs/beta/(.+?)/?$", "/docs/v2/$1", 302],
    ]);
    // The exact paths stay in the lookup table.
    expect(nodeRedirects(project)).toStrictEqual({
      "/docs/old": ["/docs/new", 302],
    });
    expect(nodePatternRedirects(projectAt("/tmp/unused", {}))).toStrictEqual(
      []
    );
  });
});

describe("wrapNodeEntry with redirects", () => {
  it("wraps the entry for redirects alone", async () => {
    const root = await scratch();
    const serverDir = join(root, "dist", "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, NODE_ENTRY_FILE), "// astro\n", "utf-8");
    await wrapNodeEntry(
      projectAt(root, {
        // No discovery file and no downloaded asset: no header rule at all.
        agents: { api: false },
        deployment: node(),
        redirects: [{ from: "/old", status: 302, to: "/new" }],
      }),
      log
    );
    const wrapper = await readFile(join(serverDir, NODE_ENTRY_FILE), "utf-8");
    expect(wrapper).toContain('const REDIRECTS = {"/old":["/new",302]};');
    expect(wrapper).toContain('const BASE = "";');
  });
});

describe("wrapNodeEntry with pattern redirects", () => {
  it("wraps the entry for pattern redirects alone", async () => {
    const root = await scratch();
    const serverDir = join(root, "dist", "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, NODE_ENTRY_FILE), "// astro\n", "utf-8");
    await wrapNodeEntry(
      projectAt(root, {
        agents: { api: false },
        deployment: node(),
        redirects: [{ from: "/beta/:slug*", status: 302, to: "/v2/:slug*" }],
      }),
      log
    );
    const wrapper = await readFile(join(serverDir, NODE_ENTRY_FILE), "utf-8");
    expect(wrapper).toContain("const REDIRECTS = {};");
    expect(wrapper).toContain('["^/beta/(.+?)/?$","/v2/$1",302]');
  });
});
