/**
 * The playground's CORS proxy. Browsers block the "Try it" panel's `fetch`
 * whenever the documented API doesn't allow cross-origin requests from the
 * docs site, so `playground: { proxy: true }` on an `openapi()` reference
 * mounts this handler at
 * `/_api-proxy` (server output only) and the client sends its real request
 * here as `?url=<encoded target>` instead. The handler replays the request
 * upstream and mirrors the response back, so the browser only ever talks
 * same-origin.
 *
 * Kept dependency-light and `fetch`-injectable so it unit-tests without a
 * network and stays safe to bundle into the generated endpoint file.
 */

import { PROXY_HEADERS_HEADER } from "../components/openapi/request.ts";
import { readCappedBody } from "../core/request-body.ts";

/**
 * Request headers never forwarded upstream, even when the playground names
 * them: hop-by-hop headers describe this connection (not the upstream one),
 * `host`/`origin`/`referer` would leak or misattribute the docs site, `cookie`
 * would forward reader credentials to an arbitrary target, and the rest are
 * set or rewritten by the platform in front of the docs server — the
 * reader's address, the edge's own identity — whatever the browser sent.
 * `accept-encoding`/`content-length` are recomputed by the runtime's own
 * fetch.
 */
const REQUEST_DROP = {
  "accept-encoding": true,
  "cdn-loop": true,
  connection: true,
  "content-length": true,
  cookie: true,
  forwarded: true,
  host: true,
  "keep-alive": true,
  origin: true,
  "proxy-authorization": true,
  referer: true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  "true-client-ip": true,
  upgrade: true,
  via: true,
  "x-client-ip": true,
  "x-real-ip": true,
} satisfies Record<string, true>;

/**
 * Platform header families, dropped like {@link REQUEST_DROP}: Cloudflare's
 * (`cf-connecting-ip`, the Access `cf-access-jwt-assertion`), the
 * `x-forwarded-*` set, Vercel's (`x-vercel-oidc-token`), Netlify's, Fly's,
 * and AWS load balancers' (`x-amzn-oidc-data`).
 */
const PLATFORM_HEADER = /^(?:cf-|x-forwarded-|x-vercel-|x-nf-|fly-|x-amzn-)/u;

/** The {@link PROXY_HEADERS_HEADER} name as `Headers` iterates it. */
const DECLARED = PROXY_HEADERS_HEADER.toLowerCase();

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

/**
 * Deadline for the whole upstream exchange, redirects included. The
 * playground client aborts its own request after 30 s, but that never
 * reaches the server-side fetch: without a deadline here, a documented API
 * that accepts the connection and never answers would hold a server request
 * slot until the platform killed it. Matches the client's limit.
 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Largest request body the proxy forwards: 4 MiB, under Vercel's 4.5 MB
 * function limit, so a request that works on one host works on the others.
 * The body is buffered before it's replayed, and a self-hosted Node server
 * has no platform cap of its own, so without this one oversized POST could
 * allocate its whole size in the server's memory.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Headers every proxied response carries. The proxy serves another host's
 * bytes from the docs origin, so an upstream HTML page — an error page that
 * echoes its input, say — would otherwise run script as the docs site for
 * anyone who opens a crafted `/_api-proxy?url=…` link. `sandbox` gives such a
 * page an opaque origin with scripts off, `nosniff` stops a mistyped body
 * being rendered as HTML, and `same-origin` keeps other sites from embedding
 * the responses. None of them affect the playground's own `fetch`.
 */
const RESPONSE_SECURITY_HEADERS = {
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} satisfies Record<string, string>;

/**
 * Media types a browser would render as a document when the proxy URL is
 * opened directly. Their responses are also marked as downloads, so even a
 * browser that ignores the sandbox saves the page instead of showing it.
 */
const DOCUMENT_TYPE =
  /^\s*(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)\b/iu;

/** A 400 the playground client can render verbatim. */
const badRequest = (error: string): Response =>
  Response.json({ error }, { status: 400 });

/**
 * Copy headers, skipping the given denylist and any name `keep` rejects
 * (names are already lowercase).
 */
const filterHeaders = (
  source: Headers,
  drop: Record<string, true>,
  keep: (name: string) => boolean = () => true
): Headers => {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!drop[name] && keep(name)) {
      headers.set(name, value);
    }
  }
  return headers;
};

/**
 * The headers to send upstream: only those the playground set itself, which
 * it names in {@link PROXY_HEADERS_HEADER}. Forwarding everything else minus
 * a denylist would hand the documented API whatever the browser and the
 * platform attach on their own — the HTTP Basic credentials of a docs site
 * behind a password (a same-origin fetch with no `Authorization` of its own
 * carries them), a Cloudflare Access assertion, a Vercel OIDC token.
 */
const forwardedHeaders = (source: Headers): Headers => {
  const named = new Set(
    (source.get(DECLARED) ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
  );
  return filterHeaders(
    source,
    REQUEST_DROP,
    (name) => named.has(name) && !PLATFORM_HEADER.test(name)
  );
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
  body: Uint8Array<ArrayBuffer> | undefined;
  fetchImpl: typeof fetch;
  headers: Headers;
  /** Hops already followed; the chain is bounded by {@link MAX_REDIRECTS}. */
  hop: number;
  method: string;
  /** One deadline shared by every hop, so a redirect chain can't extend it. */
  signal: AbortSignal;
  url: URL;
}): Promise<Response> => {
  const response = await args.fetchImpl(args.url, {
    body: args.body,
    headers: args.headers,
    method: args.method,
    redirect: "manual",
    signal: args.signal,
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
 * forwards the method, the body, and the headers the client names (see
 * {@link forwardedHeaders}), and mirrors the upstream response
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
 *
 * `timeoutMs` bounds the upstream exchange (see {@link UPSTREAM_TIMEOUT_MS});
 * an upstream that doesn't answer in time is the same 502 as an unreachable
 * one. Injectable so tests don't wait out the real deadline. A request body
 * over `maxBodyBytes` (see {@link MAX_BODY_BYTES}) is a 413, and every
 * mirrored response carries {@link RESPONSE_SECURITY_HEADERS}.
 */
export const createPlaygroundProxyHandler = (
  origins: readonly string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  maxBodyBytes = MAX_BODY_BYTES
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
    // streaming request bodies have in Node. The buffer is capped.
    const bodyless = request.method === "GET" || request.method === "HEAD";
    const body = bodyless
      ? undefined
      : await readCappedBody(request, maxBodyBytes);
    if (!bodyless && body === undefined) {
      return Response.json(
        {
          error: `The request body is larger than the ${maxBodyBytes}-byte limit the docs proxy forwards.`,
        },
        { status: 413 }
      );
    }

    let upstream: Response;
    try {
      upstream = await followUpstream({
        allowed,
        body,
        fetchImpl,
        headers: forwardedHeaders(request.headers),
        hop: 0,
        method: request.method,
        signal: AbortSignal.timeout(timeoutMs),
        url: parsed,
      });
    } catch (error) {
      // SAFETY: followUpstream itself only throws `new Error(...)`, a failed
      // fetch rejects with a TypeError per spec, and a timed-out one with a
      // `TimeoutError` DOMException — all Errors carrying `.name` and
      // `.message`.
      const { name, message } = error as Error;
      return Response.json(
        {
          error:
            name === "TimeoutError"
              ? `Upstream ${parsed.href} did not respond within ${timeoutMs}ms.`
              : message,
        },
        { status: 502 }
      );
    }

    const headers = filterHeaders(upstream.headers, RESPONSE_DROP);
    // Marks proxied responses so the client (and debugging humans) can tell
    // them apart from direct responses.
    headers.set("x-blume-proxy", "1");
    for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) {
      headers.set(name, value);
    }
    if (DOCUMENT_TYPE.test(headers.get("content-type") ?? "")) {
      headers.set("Content-Disposition", "attachment");
    }
    return new Response(upstream.body, {
      headers,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  };
};
