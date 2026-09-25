import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { operationModel } from "../src/components/openapi/operation-model.ts";
import { initPlayground } from "../src/components/openapi/playground-client.ts";
import type { PlaygroundModel } from "../src/components/openapi/request.ts";
import { buildRequest } from "../src/components/openapi/request.ts";
import { sampleLanguages } from "../src/components/openapi/snippets.ts";
import { asElement, el, fire, installFakeDom } from "./fake-dom.ts";

/**
 * fetch refuses the TRACE method — browsers and Node's fetch both throw before
 * sending — so a TRACE operation's JavaScript sample and its live Send must
 * say so, rather than emit a call that can only throw or blame CORS.
 */

let fetchCalls: string[] = [];
let restoreDom: () => void;
const dirs: string[] = [];

beforeAll(() => {
  restoreDom = installFakeDom({
    fetch: (url) => {
      fetchCalls.push(url);
      return Promise.resolve(new Response("{}"));
    },
  });
});

afterAll(async () => {
  restoreDom();
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

afterEach(() => {
  fetchCalls = [];
});

const model = (method: string): PlaygroundModel =>
  operationModel({
    method,
    parameters: [],
    path: "/pets",
    schemas: {},
    security: { alternatives: [], optional: false },
    servers: [{ url: "https://api.example.com" }],
  });

const sample = (id: string, method: string): string => {
  const [language] = sampleLanguages([id]);
  if (!language) {
    throw new Error(`no ${id} sample language`);
  }
  return language.build(
    buildRequest(model(method), {
      auth: {},
      params: {},
      server: "https://api.example.com",
    })
  );
};

/** Send from a bare panel for `method`; the response region's text. */
const send = async (method: string): Promise<string> => {
  const root = el("blume-playground", {
    "data-storage-key": `blume-playground:pets:${method}`,
  });
  root.append(
    el(
      "script",
      { "data-playground-model": "", type: "application/json" },
      JSON.stringify(model(method))
    )
  );
  const sendButton = el("button", { "data-send": "" });
  const response = el("div", { "data-response": "" });
  root.append(sendButton, response);
  initPlayground(asElement(root));
  await Promise.all(fire(sendButton, "click", sendButton));
  return response.textContent;
};

describe("TRACE operations", () => {
  it("replaces the fetch sample with a note that parses", async () => {
    const js = sample("js", "trace");
    expect(js).not.toContain("await fetch");
    expect(js).toContain("fetch() refuses the TRACE method");
    const dir = await mkdtemp(join(tmpdir(), "blume-trace-sample-"));
    dirs.push(dir);
    const file = join(dir, "sample.mjs");
    await writeFile(file, js);
    const check = spawnSync("node", ["--check", file], { encoding: "utf-8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    // The other samples can send it.
    expect(sample("curl", "trace")).toBe(
      "curl -X TRACE 'https://api.example.com/pets'"
    );
    // Every other method keeps its fetch call.
    expect(sample("js", "get")).toContain(
      'await fetch("https://api.example.com/pets"'
    );
  });

  it("explains that browsers can't send TRACE instead of sending", async () => {
    const text = await send("trace");
    expect(text).toStartWith("Browsers don't allow a page to send a `TRACE`");
    expect(fetchCalls).toStrictEqual([]);
    // Other methods still go out.
    await send("get");
    expect(fetchCalls).toStrictEqual(["https://api.example.com/pets"]);
  });
});
