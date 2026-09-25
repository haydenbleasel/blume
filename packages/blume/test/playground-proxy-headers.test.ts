import { describe, expect, it } from "bun:test";

import { createPlaygroundProxyHandler } from "../src/openapi/proxy.ts";

/**
 * Which request headers the playground proxy forwards: only the ones the
 * playground names in `X-Blume-Proxy-Headers`, and never a platform or
 * infrastructure header even then. Everything the browser or the platform
 * attaches on its own — HTTP Basic credentials for a password-protected docs
 * site, a Cloudflare Access assertion, a Vercel OIDC token — stays behind.
 */

/** Headers a request can pick up without the playground setting them. */
const AMBIENT = {
  authorization: "Basic ZG9jczpzZWNyZXQ=",
  "cf-access-jwt-assertion": "eyJ.access.jwt",
  "cf-connecting-ip": "203.0.113.7",
  forwarded: "for=203.0.113.7",
  "x-amzn-oidc-data": "eyJ.alb.jwt",
  "x-forwarded-for": "203.0.113.7",
  "x-real-ip": "203.0.113.7",
  "x-vercel-id": "iad1::abc",
  "x-vercel-oidc-token": "eyJ.vercel.jwt",
};

/** Send one proxied GET and return the headers that reached upstream. */
const forwarded = async (headers: Record<string, string>): Promise<Headers> => {
  let sent: Headers | undefined;
  const upstream = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return Promise.resolve(new Response("ok"));
    },
    { preconnect: fetch.preconnect }
  );
  const handler = createPlaygroundProxyHandler(
    ["https://api.example"],
    upstream
  );
  await handler(
    new Request(
      `http://docs.local/_api-proxy?url=${encodeURIComponent("https://api.example/pets")}`,
      { headers }
    )
  );
  if (!sent) {
    throw new Error("nothing was sent upstream");
  }
  return sent;
};

describe("playground proxy request headers", () => {
  it("forwards nothing the playground didn't name", async () => {
    const sent = await forwarded({ ...AMBIENT, accept: "application/json" });
    expect([...sent.keys()]).toStrictEqual([]);
  });

  it("forwards the named headers, but never platform ones", async () => {
    const sent = await forwarded({
      ...AMBIENT,
      authorization: "Bearer user-entered",
      "x-api-key": "k-1",
      "x-blume-proxy-headers": [
        "Authorization",
        "X-Api-Key",
        ...Object.keys(AMBIENT),
        "",
      ].join(", "),
    });
    // The playground's own Authorization replaces the ambient one in the
    // browser, so what arrives here is the credential the reader typed.
    expect(Object.fromEntries(sent)).toStrictEqual({
      authorization: "Bearer user-entered",
      "x-api-key": "k-1",
    });
  });
});
