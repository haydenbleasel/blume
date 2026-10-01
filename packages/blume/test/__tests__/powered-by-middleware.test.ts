import { describe, expect, it } from "bun:test";

import { onRequest } from "../../src/components/powered-by-middleware.ts";

describe("powered-by middleware", () => {
  it("adds the Blume identification header to runtime responses", async () => {
    // SAFETY: the middleware does not read the request context.
    const context = {} as Parameters<typeof onRequest>[0];
    const response = await onRequest(context, () =>
      Promise.resolve(new Response("ok"))
    );

    expect(response.headers.get("x-powered-by")).toBe("Blume");
    expect(await response.text()).toBe("ok");
  });
});
