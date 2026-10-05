import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { join } from "pathe";

import { searchClientTemplate } from "../src/astro/templates.ts";
import { createSearch } from "../src/components/layout/search/endpoint.ts";
import type { SearchResult } from "../src/components/layout/search/types.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { mixedbread } from "../src/search/adapters/index.ts";

// The search dialog queries on every keystroke, and each request to the
// Mixedbread endpoint counts toward its `rateLimit`. With `typing`, which
// only the dialog passes, the client waits for a pause in typing and aborts
// whatever a newer query supersedes, so a word costs one request and a slow
// earlier response never lands last. Other callers send each query at once.

const PKG_ROOT = join(import.meta.dir, "..");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Replace `fetch` for the requests the client sends. */
const stubFetch = (
  impl: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>
): void => {
  // SAFETY: the client only calls fetch; Bun's extra fetch statics (like
  // preconnect) are never touched.
  globalThis.fetch = impl as typeof globalThis.fetch;
};

/** The URLs a call's hits link to. */
const urls = async (call: Promise<SearchResult>): Promise<string[]> => {
  const result = await call;
  return result.hits.map((hit) => hit.url);
};

/** A package source file's text. */
const source = (path: string): string =>
  readFileSync(join(PKG_ROOT, "src", path), "utf-8");

const HITS = [{ excerpt: "Run it.", title: "Install", url: "/install" }];

describe("server-proxied search endpoint pacing", () => {
  it("sends only the last typed query of a burst, once typing pauses", async () => {
    const sent: string[] = [];
    stubFetch((_input, init) => {
      sent.push(JSON.parse(String(init?.body)).query);
      return Promise.resolve(Response.json(HITS));
    });
    const search = createSearch({ api: "/api/search", typing: true });
    const first = search("i");
    const second = search("in");
    const last = search("ins");
    // Nothing goes out until the pause ends.
    await Promise.resolve();
    expect(sent).toStrictEqual([]);
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    await expect(second).rejects.toHaveProperty("name", "AbortError");
    expect(await urls(last)).toStrictEqual(["/install"]);
    expect(sent).toStrictEqual(["ins"]);
  });

  it("aborts the typed request in flight when a newer query supersedes it", async () => {
    const signals: AbortSignal[] = [];
    const firstSent = Promise.withResolvers<boolean>();
    stubFetch((_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        return Promise.reject(new Error("The request carries no signal."));
      }
      signals.push(signal);
      if (signals.length > 1) {
        return Promise.resolve(Response.json(HITS));
      }
      // The first request hangs until it's aborted, as a slow one would.
      firstSent.resolve(true);
      const hung = Promise.withResolvers<Response>();
      signal.addEventListener("abort", () => hung.reject(signal.reason));
      return hung.promise;
    });
    const search = createSearch({ api: "/api/search", typing: true });
    const slow = search("instal");
    await firstSent.promise;
    const latest = search("install");
    await expect(slow).rejects.toHaveProperty("name", "AbortError");
    expect(signals[0]?.aborted).toBe(true);
    expect(await urls(latest)).toStrictEqual(["/install"]);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("sends every other caller's query at once, overlapping or not", async () => {
    const sent: string[] = [];
    stubFetch((_input, init) => {
      sent.push(JSON.parse(String(init?.body)).query);
      expect(init?.signal).toBeUndefined();
      return Promise.resolve(Response.json(HITS));
    });
    const search = createSearch({ api: "/api/search" });
    const first = search("install");
    const second = search("deploy");
    // Both went out before either settled.
    expect(sent).toStrictEqual(["install", "deploy"]);
    expect(await urls(first)).toStrictEqual(["/install"]);
    expect(await urls(second)).toStrictEqual(["/install"]);
  });

  it("paces only the dialog: useSearch and the WebMCP tool send at once", () => {
    const client = searchClientTemplate(
      blumeConfigSchema.parse({ search: mixedbread({ storeId: "store_7" }) })
    );
    expect(client).toContain(
      "export const createSearch = (options: SearchClientOptions = {}) =>\n  create({ ...options, api });"
    );
    expect(source("components/layout/Search.astro")).toContain(
      "await createSearch({ typing: true });"
    );
    expect(source("components/islands/hooks.ts")).toContain(
      "searchFn.current = await createSearch();"
    );
    expect(source("components/layout/WebMcp.astro")).toContain(
      '(await import("blume:search-client")).createSearch(),'
    );
  });
});
