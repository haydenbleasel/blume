import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { validateLinks } from "../src/core/links.ts";
import { pageMetaSchema } from "../src/core/schema.ts";
import type { ContentGraph, Diagnostic, PageLink } from "../src/core/types.ts";

// Distinct occurrences sit on distinct lines in a real document; the dedupe
// in `validateLinks` treats same-position same-message reports as one.
const link = (target: string, line = 1): PageLink => ({
  column: 1,
  line,
  target,
});

const graphWith = (links: PageLink[]): ContentGraph => ({
  diagnostics: [],
  navigation: {
    featured: [],
    selectors: [],
    sidebar: [],
    tabs: [],
  },
  navigationByLocale: {},
  navigationByVersion: {},
  pages: [
    {
      contentType: "doc",
      format: "mdx",
      groups: [],
      headings: [],
      id: "a.mdx",
      links,
      locale: "",
      meta: pageMetaSchema.parse({}),
      navPath: "a.mdx",
      route: "/a",
      segments: [],
      source: { name: "filesystem", ref: "a.mdx" },
      sourcePath: "/abs/a.mdx",
      title: "A",
      translationKey: "/a",
      version: "",
      versionKey: "/a",
    },
  ],
  routes: new Map([["/a", "a.mdx"]]),
});

const check = (links: PageLink[]): Promise<Diagnostic[]> =>
  validateLinks(graphWith(links), { checkExternal: true, publicDir: null });

const byUrl = (
  diagnostics: Diagnostic[],
  url: string
): Diagnostic | undefined => diagnostics.find((d) => d.message.includes(url));

const calls: { method: string; url: string }[] = [];

const fetchMock = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, url });

  if (url === "https://timeout.example") {
    const error = new Error("aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  if (url === "https://network.example") {
    return Promise.reject(new TypeError("network down"));
  }
  if (url === "https://method.example") {
    return Promise.resolve(
      new Response(null, { status: method === "HEAD" ? 405 : 200 })
    );
  }
  const statusByUrl = new Map([
    ["https://notfound.example", 404],
    ["https://ok.example", 200],
    ["https://server.example", 500],
  ]);
  return Promise.resolve(
    new Response(null, { status: statusByUrl.get(url) ?? 200 })
  );
};

const originalFetch = globalThis.fetch;

beforeAll(() => {
  // SAFETY: the fake covers the (input, init) call `validateLinks` makes;
  // fetch's static helpers are never touched by the probe.
  globalThis.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  calls.length = 0;
});

describe("validateLinks — external link probing", () => {
  it("grades each external link by its probe result", async () => {
    const diagnostics = await check([
      link("https://ok.example"),
      link("https://notfound.example"),
      link("https://server.example"),
      link("https://timeout.example"),
      link("https://network.example"),
    ]);

    // Only the unreachable links produce diagnostics; the 200 does not.
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.every((d) => d.code === "BLUME_DEAD_LINK")).toBe(true);

    expect(byUrl(diagnostics, "notfound.example")?.severity).toBe("error");
    expect(byUrl(diagnostics, "notfound.example")?.message).toContain(
      "HTTP 404"
    );
    expect(byUrl(diagnostics, "server.example")?.severity).toBe("warning");
    expect(byUrl(diagnostics, "server.example")?.message).toContain("HTTP 500");
    expect(byUrl(diagnostics, "timeout.example")?.severity).toBe("warning");
    expect(byUrl(diagnostics, "timeout.example")?.message).toContain(
      "request timed out"
    );
    expect(byUrl(diagnostics, "network.example")?.severity).toBe("error");
    expect(byUrl(diagnostics, "network.example")?.message).toContain(
      "network down"
    );
  });

  it("retries with GET when HEAD is rejected by the server", async () => {
    const diagnostics = await check([link("https://method.example")]);
    expect(diagnostics).toHaveLength(0);
    expect(calls.map((c) => c.method)).toStrictEqual(["HEAD", "GET"]);
  });

  it("probes each unique URL once but reports every occurrence", async () => {
    const diagnostics = await check([
      link("https://notfound.example"),
      link("https://notfound.example", 2),
    ]);
    expect(diagnostics).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("aborts a hung request when the timeout fires", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realFetch = globalThis.fetch;
    // Fire the abort timer synchronously so the controller trips before fetch
    // settles, exercising the `setTimeout(() => controller.abort())` guard.
    // SAFETY: the fake covers the (handler) call the probe's timeout makes;
    // the wider setTimeout overloads are never exercised here.
    globalThis.setTimeout = ((handler: () => void) => {
      handler();
      // A real no-op timer supplies the timer object the caller hands to
      // clearTimeout.
      return realSetTimeout(() => {}, 0);
    }) as typeof globalThis.setTimeout;
    // SAFETY: the fake covers the (input, init) call the probe makes; fetch's
    // static helpers are never touched.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;
    try {
      const diagnostics = await check([link("https://hung.example")]);
      expect(byUrl(diagnostics, "hung.example")?.severity).toBe("warning");
      expect(byUrl(diagnostics, "hung.example")?.message).toContain(
        "request timed out"
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.fetch = realFetch;
    }
  });
});
