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
const REQUEST_DROP = {
  "accept-encoding": true,
  connection: true,
  "content-length": true,
  cookie: true,
  host: true,
  origin: true,
  referer: true,
} satisfies Record<string, true>;

/**
 * Upstream response headers never returned to the browser: the runtime's
 * fetch already decoded the body (so `content-encoding`/`content-length` no
 * longer describe it), hop-by-hop headers belong to the upstream connection
 * rather than ours, and `set-cookie` would let the documented API plant
 * cookies on the docs origin — where they'd ride along on every later docs
 * request, including the proxy's own.
 */
const RESPONSE_DROP = {
  connection: true,
  "content-encoding": true,
  "content-length": true,
  "keep-alive": true,
  "set-cookie": true,
  "transfer-encoding": true,
} satisfies Record<string, true>;

/** Redirect statuses the handler resolves itself; see {@link followUpstream}. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Hops followed before giving up, matching fetch's own redirect limit. */
const MAX_REDIRECTS = 20;

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

/** A 403 for a target no configured spec declares as one of its servers. */
const forbidden = (origin: string): Response =>
  Response.json(
    {
      error:
        `${origin} is not one of the API servers this documentation declares, ` +
        "so the docs proxy will not request it.",
    },
    { status: 403 }
  );

/**
 * Follow the upstream chain by hand, re-checking every hop. Redirects are
 * deliberately NOT delegated to fetch: `redirect: "follow"` would chase a
 * `Location` to any host, so an allowlisted first hop could bounce the docs
 * server onto an internal address it must never reach. The rewrite rules match
 * fetch's own — 303 (and 301/302, as every browser does) degrade to a bodyless
 * GET, 307/308 replay the method and body.
 */
const followUpstream = async (args: {
  allowed: ReadonlySet<string>;
  body: ArrayBuffer | undefined;
  fetchImpl: typeof fetch;
  headers: Headers;
  /** Hops already followed; the chain is bounded by {@link MAX_REDIRECTS}. */
  hop: number;
  method: string;
  url: URL;
}): Promise<Response> => {
  const response = await args.fetchImpl(args.url, {
    body: args.body,
    headers: args.headers,
    method: args.method,
    redirect: "manual",
  });
  const location = REDIRECT_STATUS.has(response.status)
    ? response.headers.get("location")
    : null;
  if (location === null) {
    return response;
  }
  if (args.hop >= MAX_REDIRECTS) {
    throw new Error(`Too many redirects from ${args.url.href}.`);
  }
  let next: URL;
  try {
    next = new URL(location, args.url);
  } catch {
    throw new Error(`Upstream redirected to an invalid URL: ${location}`);
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new Error(`Upstream redirected to a non-http(s) URL: ${location}`);
  }
  if (!args.allowed.has(next.origin)) {
    return forbidden(next.origin);
  }
  // 307/308 replay the request as-is; the rest degrade to a bodyless GET.
  const replay = response.status === 307 || response.status === 308;
  return followUpstream({
    ...args,
    body: replay ? args.body : undefined,
    hop: args.hop + 1,
    method: replay || args.method === "HEAD" ? args.method : "GET",
    url: next,
  });
};

/**
 * Build the `/_api-proxy` fetch handler. The client sends its REAL method,
 * headers, and body to `?url=<encodeURIComponent(target)>`; the handler
 * forwards them (minus {@link REQUEST_DROP}) and mirrors the upstream response
 * (minus {@link RESPONSE_DROP}) with an `x-blume-proxy` marker. An unreachable
 * upstream is a 502 with a JSON `error`.
 *
 * `origins` is the allowlist: the origins of the `servers` the documented specs
 * themselves declare (derived at build time). Without it the endpoint would be
 * an open proxy — any visitor could aim the docs deployment at cloud metadata
 * or a service on its private network. Non-absolute and non-http(s) targets are
 * a 400; anything outside the allowlist, including on a redirect hop, is a 403.
 * Loopback and private addresses need no separate rule: they are reachable only
 * when a spec documents them, which is exactly the local-API case that must
 * keep working.
 */
export const createPlaygroundProxyHandler = (
  origins: readonly string[],
  fetchImpl: typeof fetch = fetch
) => {
  const allowed = new Set(origins);
  return async (request: Request): Promise<Response> => {
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
    if (!allowed.has(parsed.origin)) {
      return forbidden(parsed.origin);
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
      upstream = await followUpstream({
        allowed,
        body,
        fetchImpl,
        headers: filterHeaders(request.headers, REQUEST_DROP),
        hop: 0,
        method: request.method,
        url: parsed,
      });
    } catch (error) {
      // SAFETY: followUpstream itself only throws `new Error(...)`, and a
      // failed fetch rejects with a TypeError per spec — both are Errors
      // carrying `.message`.
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
};
