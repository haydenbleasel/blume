import { describe, expect, it } from "bun:test";

import { createPlaygroundProxyHandler } from "../src/openapi/proxy.ts";

/** Narrow a maybe-undefined recorded value; a missing call is a test bug. */
const must = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) {
    throw new Error("expected value");
  }
  return value;
};

/** The proxy request the playground client sends: `?url=<encoded target>`. */
const proxyRequest = (target: string | null, init?: RequestInit): Request =>
  new Request(
    target === null
      ? "http://docs.local/_api-proxy"
      : `http://docs.local/_api-proxy?url=${encodeURIComponent(target)}`,
    init
  );

/** A fake upstream fetch that records its call and yields a fixed response. */
const fakeFetch = (response: Response) => {
  let url: URL | undefined;
  let init: RequestInit | undefined;
  const impl = ((input: URL, options?: RequestInit) => {
    url = input;
    init = options;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return {
    impl,
    get init() {
      return init;
    },
    get url() {
      return url;
    },
  };
};

describe("createPlaygroundProxyHandler", () => {
  it("rejects a missing url param with a 400 (default fetch untouched)", async () => {
    // The default `fetch` is exercised safely here: the guard fires before
    // any network call could happen.
    const handler = createPlaygroundProxyHandler();
    const response = await handler(proxyRequest(null));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("url");
  });

  it("rejects an unparseable target URL with a 400", async () => {
    const handler = createPlaygroundProxyHandler(
      fakeFetch(new Response()).impl
    );
    const response = await handler(proxyRequest("not a url"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not a url");
  });

  it("rejects non-http(s) targets with a 400", async () => {
    const handler = createPlaygroundProxyHandler(
      fakeFetch(new Response()).impl
    );
    const response = await handler(proxyRequest("ftp://files.example/spec"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("http");
  });

  it("forwards a GET, filtering headers both ways and following redirects", async () => {
    const upstream = fakeFetch(
      new Response("pong", {
        headers: {
          connection: "keep-alive",
          "content-encoding": "gzip",
          "content-type": "application/json",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "x-rate-limit": "10",
        },
        status: 418,
        statusText: "I'm a teapot",
      })
    );
    const handler = createPlaygroundProxyHandler(upstream.impl);
    const response = await handler(
      proxyRequest("https://api.example/ping?x=1", {
        headers: {
          accept: "application/json",
          "accept-encoding": "br",
          authorization: "Bearer token",
          cookie: "session=reader",
          origin: "http://docs.local",
          referer: "http://docs.local/reference",
        },
      })
    );

    // The target (including its own query) and redirect policy pass through.
    expect(upstream.url?.href).toBe("https://api.example/ping?x=1");
    expect(upstream.init?.redirect).toBe("follow");
    expect(upstream.init?.method).toBe("GET");
    // GET carries no body (fetch rejects one).
    expect(upstream.init?.body).toBeUndefined();

    // Reader-identifying / hop-by-hop request headers never reach upstream.
    const sent = upstream.init?.headers as Headers;
    expect(sent.get("accept")).toBe("application/json");
    expect(sent.get("authorization")).toBe("Bearer token");
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("origin")).toBeNull();
    expect(sent.get("referer")).toBeNull();
    expect(sent.get("accept-encoding")).toBeNull();
    expect(sent.get("host")).toBeNull();

    // Upstream status/body mirror back, minus hop-by-hop headers, plus the
    // proxy marker.
    expect(response.status).toBe(418);
    expect(response.statusText).toBe("I'm a teapot");
    expect(await response.text()).toBe("pong");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-rate-limit")).toBe("10");
    expect(response.headers.get("x-blume-proxy")).toBe("1");
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("keep-alive")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
  });

  it("forwards a POST body verbatim", async () => {
    const upstream = fakeFetch(new Response("created", { status: 201 }));
    const handler = createPlaygroundProxyHandler(upstream.impl);
    const response = await handler(
      proxyRequest("http://api.example/pets", {
        body: '{"name":"Rex"}',
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(upstream.init?.method).toBe("POST");
    expect(
      new TextDecoder().decode(must(upstream.init?.body) as ArrayBuffer)
    ).toBe('{"name":"Rex"}');
    expect((must(upstream.init?.headers) as Headers).get("content-type")).toBe(
      "application/json"
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("created");
  });

  it("turns an unreachable upstream into a 502 with a JSON error", async () => {
    const failing = (() =>
      Promise.reject(
        new Error("getaddrinfo ENOTFOUND api.example")
      )) as unknown as typeof fetch;
    const handler = createPlaygroundProxyHandler(failing);
    const response = await handler(proxyRequest("https://api.example/ping"));
    expect(response.status).toBe(502);
    expect((await response.json()) as { error: string }).toStrictEqual({
      error: "getaddrinfo ENOTFOUND api.example",
    });
  });
});
