/**
 * The playground's CORS proxy. Browsers block the "Try it" panel's `fetch`
 * whenever the documented API doesn't allow cross-origin requests from the
 * docs site, so `openapi.playground.proxy: true` mounts this handler at
 * `/_api-proxy` (server output only) and the client sends its real request
 * here as `?url=<encoded target>` instead. The handler replays the request
 * upstream and mirrors the response back, so the browser only ever talks
 * same-origin.
 *
 * Kept dependency-free and `fetch`-injectable so it unit-tests without a
 * network and stays safe to bundle into the generated endpoint file.
 */

/**
 * Request headers never forwarded upstream: hop-by-hop headers describe this
 * connection (not the upstream one), `host`/`origin`/`referer` would leak or
 * misattribute the docs site, and `cookie` would forward reader credentials
 * to an arbitrary target. `accept-encoding`/`content-length` are recomputed
 * by the runtime's own fetch.
 */
const REQUEST_DROP: Record<string, true> = {
  "accept-encoding": true,
  connection: true,
  "content-length": true,
  cookie: true,
  host: true,
  origin: true,
  referer: true,
};

/**
 * Upstream response headers never returned to the browser: the runtime's
 * fetch already decoded the body (so `content-encoding`/`content-length` no
 * longer describe it) and hop-by-hop headers belong to the upstream
 * connection, not ours.
 */
const RESPONSE_DROP: Record<string, true> = {
  connection: true,
  "content-encoding": true,
  "content-length": true,
  "keep-alive": true,
  "transfer-encoding": true,
};

/** A 400 the playground client can render verbatim. */
const badRequest = (error: string): Response =>
  Response.json({ error }, { status: 400 });

/** Copy headers, skipping the given denylist (names are already lowercase). */
const filterHeaders = (
  source: Headers,
  drop: Record<string, true>
): Headers => {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!drop[name]) {
      headers.set(name, value);
    }
  }
  return headers;
};

/**
 * Build the `/_api-proxy` fetch handler. The client sends its REAL method,
 * headers, and body to `?url=<encodeURIComponent(target)>`; the handler
 * forwards them (minus {@link REQUEST_DROP}), follows redirects, and mirrors
 * the upstream response (minus {@link RESPONSE_DROP}) with an `x-blume-proxy`
 * marker. Only absolute `http(s)` targets are accepted — anything else is a
 * 400, and an unreachable upstream is a 502 with a JSON `error`.
 */
export const createPlaygroundProxyHandler =
  (fetchImpl: typeof fetch = fetch) =>
  async (request: Request): Promise<Response> => {
    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return badRequest("Missing `url` query parameter.");
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return badRequest(`Invalid target URL: ${target}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return badRequest("Only http(s) target URLs are allowed.");
    }

    // Buffer the body instead of streaming it: GET/HEAD must not carry one
    // (fetch rejects it), and a buffered body avoids the `duplex` requirement
    // streaming request bodies have in Node.
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();

    let upstream: Response;
    try {
      upstream = await fetchImpl(parsed, {
        body,
        headers: filterHeaders(request.headers, REQUEST_DROP),
        method: request.method,
        redirect: "follow",
      });
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: 502 }
      );
    }

    const headers = filterHeaders(upstream.headers, RESPONSE_DROP);
    // Marks proxied responses so the client (and debugging humans) can tell
    // them apart from direct responses.
    headers.set("x-blume-proxy", "1");
    return new Response(upstream.body, {
      headers,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  };
