/**
 * CORS for the generated Ask AI route (`ai.ask.cors`).
 *
 * A browser only lets a page on another origin read a response that names
 * that origin, and a JSON `POST` preflights first. `preflightResponse` answers
 * the `OPTIONS`; `withCors` wraps the `POST` handler so every response it
 * returns — the stream, a 400, a 500 — carries the headers. Wrapping once,
 * rather than stamping each `return`, keeps the next return site added to the
 * handler from shipping an opaque failure for that one status.
 *
 * `allowed` is the `ai.ask.cors` list: origins already reduced to their
 * `scheme://host[:port]` form by the config schema, or the single entry `"*"`
 * to admit every origin.
 */

/** The `ai.ask.cors` entry that admits every origin. */
export const ANY_ORIGIN = "*";

/** The headers a response carries for a cross-origin caller. */
export interface CorsHeaders {
  "access-control-allow-origin"?: string;
  vary?: string;
}

/** The response headers that name the caller's origin when `allowed` lists it. */
export const corsHeaders = (
  request: Request,
  allowed: readonly string[]
): CorsHeaders => {
  if (allowed.includes(ANY_ORIGIN)) {
    // A wildcard answer is the same for every caller, so nothing to vary on.
    return { "access-control-allow-origin": ANY_ORIGIN };
  }
  // `Vary` rides on both branches: the answer depends on `Origin` whether or
  // not it was listed, so a shared cache never hands one origin's response
  // (or the header-less one) to another.
  const origin = request.headers.get("origin");
  return origin && allowed.includes(origin)
    ? { "access-control-allow-origin": origin, vary: "origin" }
    : { vary: "origin" };
};

/** Answer the browser's `OPTIONS` preflight for the route. */
export const preflightResponse = (
  request: Request,
  allowed: readonly string[]
): Response =>
  new Response(null, {
    headers: {
      ...corsHeaders(request, allowed),
      // Reflect whatever the caller's fetch wrapper asks to send, falling back
      // to the JSON POST's own `content-type`; a listed origin shouldn't need
      // an eject to add a header of its own.
      "access-control-allow-headers":
        request.headers.get("access-control-request-headers") ?? "content-type",
      "access-control-allow-methods": "POST",
      "access-control-max-age": "86400",
    },
    status: 204,
  });

/** The slice of Astro's `APIContext` the wrapped handler reads. */
interface RequestContext {
  request: Request;
}

/** Stamp the CORS headers on every response `handler` returns. */
export const withCors =
  (
    allowed: readonly string[],
    handler: (context: RequestContext) => Promise<Response> | Response
  ): ((context: RequestContext) => Promise<Response>) =>
  async (context) => {
    const response = await handler(context);
    for (const [key, value] of Object.entries(
      corsHeaders(context.request, allowed)
    )) {
      // `Vary` accumulates (the handler may already vary on something), the
      // rest replace.
      if (key === "vary") {
        response.headers.append(key, value);
      } else {
        response.headers.set(key, value);
      }
    }
    return response;
  };
