import type { MiddlewareHandler } from "astro";

/** Adds Blume's framework-identification header to runtime responses. */
export const onRequest: MiddlewareHandler = async (_context, render) => {
  const response = await render();
  const poweredByResponse = new Response(response.body, response);
  poweredByResponse.headers.set("X-Powered-By", "Blume");
  return poweredByResponse;
};
