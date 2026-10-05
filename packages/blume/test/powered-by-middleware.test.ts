import { describe, expect, it } from "bun:test";

import { onRequest } from "../src/components/powered-by-middleware.ts";

/** The middleware's answer for the response a page rendered. */
const run = (rendered: Response): Promise<Response> => {
  // SAFETY: the middleware never reads its context.
  const context = {} as Parameters<typeof onRequest>[0];
  const next = () => Promise.resolve(rendered);
  return Promise.resolve(onRequest(context, next)).then((result) =>
    result instanceof Response ? result : new Response(String(result))
  );
};

describe("powered-by middleware", () => {
  it("names Blume on the rendered response itself", async () => {
    const rendered = new Response("<html>");
    const response = await run(rendered);
    expect(response).toBe(rendered);
    expect(response.headers.get("X-Powered-By")).toBe("Blume");
  });

  it("keeps a value the page set", async () => {
    const rendered = new Response("<html>", {
      headers: { "x-powered-by": "Acme Docs" },
    });
    const response = await run(rendered);
    expect(response).toBe(rendered);
    expect(response.headers.get("X-Powered-By")).toBe("Acme Docs");
  });

  it("copies a response whose headers are immutable", async () => {
    // What a proxied `fetch()` result is; Bun doesn't enforce the guard.
    const rendered = new Response("proxied", { status: 201 });
    rendered.headers.set = () => {
      throw new TypeError("immutable");
    };
    const response = await run(rendered);
    expect(response).not.toBe(rendered);
    expect(response.status).toBe(201);
    expect(response.headers.get("X-Powered-By")).toBe("Blume");
    expect(await response.text()).toBe("proxied");
  });
});
