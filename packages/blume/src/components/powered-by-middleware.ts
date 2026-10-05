import type { MiddlewareHandler } from "astro";

import { POWERED_BY_HEADERS } from "../core/powered-by.ts";

/**
 * Names Blume in the responses Astro renders (wired by the integration unless
 * `poweredBy` is `false`), the server-rendered ones a host's own header rules
 * don't reach. Innermost, so a page or the project's own middleware that sets
 * a header of the same name keeps its value. Headers are set in place; a
 * response whose headers are immutable (a proxied `fetch()` result) is copied
 * first.
 */
export const onRequest: MiddlewareHandler = async (_context, render) => {
  const response = await render();
  const missing = Object.entries(POWERED_BY_HEADERS).filter(
    ([name]) => !response.headers.has(name)
  );
  if (missing.length === 0) {
    return response;
  }
  try {
    for (const [name, value] of missing) {
      response.headers.set(name, value);
    }
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of missing) {
      copy.headers.set(name, value);
    }
    return copy;
  }
};
