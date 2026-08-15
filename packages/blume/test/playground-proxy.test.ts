import { describe, expect, it } from "bun:test";

import { createPlaygroundProxyHandler } from "../src/openapi/proxy.ts";

/** Narrow a maybe-undefined recorded value; a missing call is a test bug. */
const must = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) {
    throw new Error("expected value");
  }
  return value;
};

/** The origins the documented specs declare; everything else is a 403. */
const ORIGINS = ["https://api.example", "http://api.example"];

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

/**
 * A fake upstream that answers a scripted chain: each entry is consumed in
 * order, so a redirect can be followed by the response it points at. Records
 * every requested URL/init pair the handler produced.
 */
const chainFetch = (responses: Response[]) => {
  const calls: { init?: RequestInit; url: URL }[] = [];
  let index = 0;
  const impl = ((url: URL, init?: RequestInit) => {
    calls.push({ init, url });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(must(response));
  }) as unknown as typeof fetch;
  return { calls, impl };
};

const redirect = (location: string, status = 302): Response =>
  new Response(null, { headers: { location }, status });

describe("createPlaygroundProxyHandler", () => {
  it("rejects a missing url param with a 400 (default fetch untouched)", async () => {
    // The default `fetch` is exercised safely here: the guard fires before
    // any network call could happen.
    const handler = createPlaygroundProxyHandler(ORIGINS);
    const response = await handler(proxyRequest(null));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("url");
  });

  it("rejects an unparseable target URL with a 400", async () => {
    const handler = createPlaygroundProxyHandler(
      ORIGINS,
      fakeFetch(new Response()).impl
    );
    const response = await handler(proxyRequest("not a url"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not a url");
  });

  it("rejects non-http(s) targets with a 400", async () => {
    const handler = createPlaygroundProxyHandler(
      ORIGINS,
      fakeFetch(new Response()).impl
    );
    const response = await handler(proxyRequest("ftp://files.example/spec"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("http");
  });

  it("refuses a target outside the documented API origins", async () => {
    // Without this the endpoint is an open proxy: any visitor could aim the
    // docs deployment at cloud metadata or a service on its private network.
    const upstream = fakeFetch(new Response("secret"));
    const handler = createPlaygroundProxyHandler(ORIGINS, upstream.impl);
    const blocked = await Promise.all(
      [
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:8080/admin",
        "https://api.example.evil/pets",
        "https://api.example:8443/pets",
      ].map(async (target) => {
        const response = await handler(proxyRequest(target));
        const body = (await response.json()) as { error: string };
        return { error: body.error, status: response.status };
      })
    );
    for (const outcome of blocked) {
      expect(outcome.status).toBe(403);
      expect(outcome.error).toContain("not one of the API servers");
    }
    // Nothing was requested upstream.
    expect(upstream.url).toBeUndefined();
  });

  it("forwards a GET and filters headers both ways", async () => {
    const upstream = fakeFetch(
      new Response("pong", {
        headers: {
          connection: "keep-alive",
          "content-encoding": "gzip",
          "content-type": "application/json",
          "keep-alive": "timeout=5",
          "set-cookie": "session=upstream; Path=/",
          "transfer-encoding": "chunked",
          "x-rate-limit": "10",
        },
        status: 418,
        statusText: "I'm a teapot",
      })
    );
    const handler = createPlaygroundProxyHandler(ORIGINS, upstream.impl);
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

    // The target (including its own query) passes through; redirects are
    // resolved by the handler itself, never delegated to fetch.
    expect(upstream.url?.href).toBe("https://api.example/ping?x=1");
    expect(upstream.init?.redirect).toBe("manual");
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
    // proxy marker. `set-cookie` is dropped: the API must not plant cookies on
    // the docs origin, where they would ride along on every later request.
    expect(response.status).toBe(418);
    expect(response.statusText).toBe("I'm a teapot");
    expect(await response.text()).toBe("pong");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-rate-limit")).toBe("10");
    expect(response.headers.get("x-blume-proxy")).toBe("1");
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("keep-alive")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
  });

  it("forwards a POST body verbatim", async () => {
    const upstream = fakeFetch(new Response("created", { status: 201 }));
    const handler = createPlaygroundProxyHandler(ORIGINS, upstream.impl);
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

  it("follows an allowed redirect, degrading a POST to a bodyless GET", async () => {
    const upstream = chainFetch([
      redirect("/pets/1"),
      new Response("moved", { status: 200 }),
    ]);
    const handler = createPlaygroundProxyHandler(ORIGINS, upstream.impl);
    const response = await handler(
      proxyRequest("https://api.example/pets", {
        body: '{"name":"Rex"}',
        method: "POST",
      })
    );
    expect(upstream.calls.map((call) => call.url.href)).toEqual([
      "https://api.example/pets",
      "https://api.example/pets/1",
    ]);
    expect(must(upstream.calls[1]).init?.method).toBe("GET");
    expect(must(upstream.calls[1]).init?.body).toBeUndefined();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("moved");
  });

  it("replays the method and body across a 308", async () => {
    const upstream = chainFetch([
      redirect("https://api.example/v2/pets", 308),
      new Response("ok"),
    ]);
    const handler = createPlaygroundProxyHandler(ORIGINS, upstream.impl);
    await handler(
      proxyRequest("https://api.example/pets", {
        body: '{"name":"Rex"}',
        method: "PUT",
      })
    );
    expect(must(upstream.calls[1]).init?.method).toBe("PUT");
    expect(
      new TextDecoder().decode(
        must(must(upstream.calls[1]).init?.body) as ArrayBuffer
      )
    ).toBe('{"name":"Rex"}');
  });

  it("refuses a redirect that leaves the documented origins", async () => {
    // The dangerous case an automatic `redirect: "follow"` would allow: an
    // allowlisted first hop bouncing the docs server onto an internal address.
    const upstream = chainFetch([
      redirect("http://169.254.169.254/latest/meta-data/", 307),
      new Response("secret"),
    ]);
    const handler = createPlaygroundProxyHandler(ORIGINS, upstream.impl);
    const response = await handler(proxyRequest("https://api.example/pets"));
    expect(upstream.calls).toHaveLength(1);
    expect(response.status).toBe(403);
    const blocked = (await response.json()) as { error: string };
    expect(blocked.error).toContain("169.254.169.254");
  });

  it("rejects a redirect to an unusable or non-http(s) location", async () => {
    const scheme = createPlaygroundProxyHandler(
      ORIGINS,
      chainFetch([redirect("file:///etc/passwd")]).impl
    );
    const schemeResponse = await scheme(
      proxyRequest("https://api.example/pets")
    );
    expect(schemeResponse.status).toBe(502);
    expect((await schemeResponse.json()) as { error: string }).toStrictEqual({
      error: "Upstream redirected to a non-http(s) URL: file:///etc/passwd",
    });

    const broken = createPlaygroundProxyHandler(
      ORIGINS,
      chainFetch([redirect("http://")]).impl
    );
    const brokenResponse = await broken(
      proxyRequest("https://api.example/pets")
    );
    expect(brokenResponse.status).toBe(502);
    expect((await brokenResponse.json()) as { error: string }).toStrictEqual({
      error: "Upstream redirected to an invalid URL: http://",
    });

    const loop = createPlaygroundProxyHandler(
      ORIGINS,
      chainFetch([redirect("/loop")]).impl
    );
    const loopResponse = await loop(proxyRequest("https://api.example/pets"));
    expect(loopResponse.status).toBe(502);
    const body = (await loopResponse.json()) as { error: string };
    expect(body.error).toContain("Too many redirects");
  });

  it("turns an unreachable upstream into a 502 with a JSON error", async () => {
    const failing = (() =>
      Promise.reject(
        new Error("getaddrinfo ENOTFOUND api.example")
      )) as unknown as typeof fetch;
    const handler = createPlaygroundProxyHandler(ORIGINS, failing);
    const response = await handler(proxyRequest("https://api.example/ping"));
    expect(response.status).toBe(502);
    expect((await response.json()) as { error: string }).toStrictEqual({
      error: "getaddrinfo ENOTFOUND api.example",
    });
  });
});
