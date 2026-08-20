import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { join } from "pathe";

import type { McpData } from "../src/ai/mcp/data.ts";
import { serveMcpStdio } from "../src/ai/mcp/stdio.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const DATA: McpData = {
  base: "",
  documents: [
    {
      content:
        "Install Blume with your package manager, then run the dev server.",
      description: "How to install Blume",
      route: "/guides/install",
      title: "Installation",
    },
  ],
  name: "Test Docs",
  navigation: { featured: [], selectors: [], sidebar: [], tabs: [] },
  pages: {
    "/guides/install":
      "---\ntitle: Installation\n---\n# Installation\n\nInstall it.",
  },
  routes: [
    {
      contentType: "doc",
      description: "How to install Blume",
      indexable: true,
      lastModified: null,
      locale: "en",
      route: "/guides/install",
      title: "Installation",
      version: "",
    },
  ],
  site: null,
  version: "0.0.0",
};

interface RpcResponse {
  id?: number;
  result?: {
    content?: { text: string }[];
    isError?: boolean;
    serverInfo?: { name: string; version: string };
    tools?: { name: string }[];
  };
}

const isText = (chunk: Uint8Array | string): chunk is string =>
  typeof chunk === "string";

/**
 * Yield newline-delimited JSON-RPC responses as they stream in. Works over
 * both Node streams (`PassThrough`) and Bun subprocess stdout (a web
 * `ReadableStream`) — each is async-iterable.
 *
 * @yields {string} one raw JSON-RPC line at a time.
 */
const readLines = async function* readLines(
  stream: AsyncIterable<Uint8Array | string>
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += isText(chunk) ? chunk : decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
};

const lineReader = (stream: AsyncIterable<Uint8Array | string>) => {
  const lines = readLines(stream);
  return async (): Promise<RpcResponse> => {
    const { done, value } = await lines.next();
    if (done) {
      throw new Error("stream ended before a response arrived");
    }
    // SAFETY: each line is one JSON-RPC response emitted by the server under
    // test, which speaks newline-delimited JSON-RPC exclusively.
    return JSON.parse(value) as RpcResponse;
  };
};

const INITIALIZE = {
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
    protocolVersion: "2025-06-18",
  },
};

const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("serveMcpStdio", () => {
  it("answers initialize and tool calls over in-memory streams, and resolves on stdin EOF", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const readResponse = lineReader(stdout);
    const done = serveMcpStdio(DATA, { stdin, stdout });

    stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
    const init = await readResponse();
    expect(init.id).toBe(1);
    expect(init.result?.serverInfo?.name).toBe("Test Docs");

    stdin.write(`${JSON.stringify(INITIALIZED)}\n`);
    stdin.write(
      `${JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/list",
      })}\n`
    );
    const list = await readResponse();
    expect(list.result?.tools?.map((tool) => tool.name).toSorted()).toEqual([
      "get_navigation",
      "get_page",
      "list_pages",
      "search_docs",
    ]);

    stdin.write(
      `${JSON.stringify({
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { query: "install" },
          name: "search_docs",
        },
      })}\n`
    );
    const search = await readResponse();
    expect(search.result?.content?.[0]?.text).toContain("/guides/install");

    stdin.write(
      `${JSON.stringify({
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { route: "/guides/install" }, name: "get_page" },
      })}\n`
    );
    const page = await readResponse();
    expect(page.result?.content?.[0]?.text).toContain("# Installation");

    // The client hanging up (EOF) must end the serve loop — the SDK transport
    // does not watch for it on its own.
    stdin.end();
    await done;
  });
});

describe("blume mcp-stdio", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  const snapshotFixture = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "blume-mcp-stdio-"));
    dirs.push(dir);
    const path = join(dir, "mcp-data.json");
    await writeFile(path, JSON.stringify(DATA));
    return path;
  };

  it("serves a snapshot over real stdio and exits cleanly on EOF", async () => {
    const snapshot = await snapshotFixture();
    const proc = Bun.spawn(
      [process.execPath, CLI, "mcp-stdio", "--data", snapshot],
      { stderr: "pipe", stdin: "pipe", stdout: "pipe" }
    );
    const readResponse = lineReader(proc.stdout);

    proc.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
    proc.stdin.flush();
    const init = await readResponse();
    expect(init.result?.serverInfo?.name).toBe("Test Docs");

    proc.stdin.write(`${JSON.stringify(INITIALIZED)}\n`);
    proc.stdin.write(
      `${JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { route: "/guides/install" }, name: "get_page" },
      })}\n`
    );
    proc.stdin.flush();
    const page = await readResponse();
    expect(page.result?.content?.[0]?.text).toContain("Install it.");

    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });

  it("exits 1 with a stderr message when the snapshot cannot be loaded", async () => {
    const proc = Bun.spawn(
      [process.execPath, CLI, "mcp-stdio", "--data", "/nonexistent/data.json"],
      { stderr: "pipe", stdin: "pipe", stdout: "pipe" }
    );
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot load the snapshot");
  });
});
