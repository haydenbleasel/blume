import { describe, expect, it } from "bun:test";

import { corsHeaders, preflightResponse, withCors } from "../src/ai/cors.ts";

const ALLOWED = ["https://www.example.com", "http://localhost:3000"];

const request = (headers: Record<string, string> = {}): Request =>
  new Request("https://docs.example.com/api/ask", {
    headers,
    method: "POST",
  });

describe("corsHeaders", () => {
  it("names a listed origin and varies on it", () => {
    expect(
      corsHeaders(request({ origin: "http://localhost:3000" }), ALLOWED)
    ).toStrictEqual({
      "access-control-allow-origin": "http://localhost:3000",
      vary: "origin",
    });
  });

  it("still varies on Origin when it is unlisted or absent", () => {
    // The answer depends on `Origin` either way, so a shared cache must not
    // hand the header-less response to a listed origin (or vice versa).
    expect(
      corsHeaders(request({ origin: "https://evil.example" }), ALLOWED)
    ).toStrictEqual({ vary: "origin" });
    expect(corsHeaders(request(), ALLOWED)).toStrictEqual({ vary: "origin" });
  });

  it("answers a wildcard list with a wildcard, for any caller", () => {
    expect(
      corsHeaders(request({ origin: "https://anything.example" }), ["*"])
    ).toStrictEqual({ "access-control-allow-origin": "*" });
    expect(corsHeaders(request(), ["*"])).toStrictEqual({
      "access-control-allow-origin": "*",
    });
  });
});

describe("preflightResponse", () => {
  it("answers a listed origin with the allow headers", () => {
    const response = preflightResponse(
      request({ origin: "https://www.example.com" }),
      ALLOWED
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://www.example.com"
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type"
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(response.headers.get("vary")).toBe("origin");
  });

  it("reflects the headers the caller asks to send", () => {
    const response = preflightResponse(
      request({
        "access-control-request-headers": "content-type, x-requested-with",
        origin: "https://www.example.com",
      }),
      ALLOWED
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, x-requested-with"
    );
  });

  it("gives an unlisted origin no allow-origin but keeps Vary", () => {
    const response = preflightResponse(
      request({ origin: "https://evil.example" }),
      ALLOWED
    );
    expect(response.status).toBe(204);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.get("vary")).toBe("origin");
  });
});

describe("withCors", () => {
  it("stamps every response the handler returns", async () => {
    const post = withCors(ALLOWED, ({ request: incoming }) =>
      incoming.headers.has("x-fail")
        ? new Response("nope", { status: 400 })
        : new Response("ok")
    );
    const ok = await post({
      request: request({ origin: "https://www.example.com" }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(
      "https://www.example.com"
    );
    const failed = await post({
      request: request({ origin: "https://www.example.com", "x-fail": "1" }),
    });
    expect(failed.status).toBe(400);
    expect(failed.headers.get("access-control-allow-origin")).toBe(
      "https://www.example.com"
    );
  });

  it("appends to an existing Vary and replaces the rest", async () => {
    const post = withCors(
      ALLOWED,
      () =>
        new Response("ok", {
          headers: {
            "access-control-allow-origin": "https://stale.example",
            vary: "accept",
          },
        })
    );
    const response = await post({
      request: request({ origin: "http://localhost:3000" }),
    });
    expect(response.headers.get("vary")).toBe("accept, origin");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000"
    );
  });

  it("leaves an unlisted origin without an allow header", async () => {
    const post = withCors(ALLOWED, () => new Response("ok"));
    const response = await post({
      request: request({ origin: "https://evil.example" }),
    });
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.get("vary")).toBe("origin");
  });
});
