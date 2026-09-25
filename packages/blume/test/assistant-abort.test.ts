import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { join } from "pathe";

import { openaiCompatible, resolveAskBackend } from "../src/ai/ask.ts";
import { askEndpointTemplate } from "../src/astro/templates.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

/**
 * End to end over the generated assistant route: a fake OpenAI-compatible
 * upstream streams one token and then holds the answer open, the way a model
 * mid-generation does, and the reader closes the panel.
 */

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The generated route's handler, called the way Astro calls an endpoint. */
type AskRoute = (context: { request: Request }) => Promise<Response>;

/** One OpenAI chat-completions stream chunk carrying `content`. */
const chunk = (content: string): string =>
  `data: ${JSON.stringify({
    choices: [{ delta: { content, role: "assistant" }, index: 0 }],
    created: 0,
    id: "chatcmpl-1",
    model: "m",
    object: "chat.completion.chunk",
  })}\n\n`;

/** Resolves `true` once the model call's HTTP request is cancelled. */
const upstreamAborted = Promise.withResolvers<boolean>();

const upstream = Bun.serve({
  fetch(request) {
    request.signal.addEventListener("abort", () => {
      upstreamAborted.resolve(true);
    });
    // One token, then the stream stays open: the model is still generating.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk("Hello")));
      },
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
  port: 0,
});

const dirs: string[] = [];

const errorSpy = spyOn(console, "error");

afterAll(async () => {
  // The spy wraps the process-wide console; hand it back for the next file.
  errorSpy.mockRestore();
  await upstream.stop(true);
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/**
 * Write the generated route where it can load outside Astro: the one Astro
 * virtual import becomes a stub key lookup, and the bare specifiers resolve
 * from the Blume package.
 */
const loadRoute = async (): Promise<AskRoute> => {
  const parsed = blumeConfigSchema.parse({
    ai: {
      assistant: {
        enabled: true,
        provider: openaiCompatible({
          apiKeyEnv: "TEST_KEY",
          baseUrl: `http://localhost:${upstream.port}/v1`,
          model: "m",
        }),
      },
    },
  });
  // Ungrounded, so the route needs no retrieval corpus; the grounded path
  // builds the same `streamText` call.
  const backend = {
    ...resolveAskBackend(parsed.ai.assistant?.provider),
    grounded: false,
  };
  const resolve = (specifier: string): string =>
    pathToFileURL(Bun.resolveSync(specifier, PKG_ROOT)).href;
  const source = askEndpointTemplate(backend)
    .replace(
      'import { getSecret } from "astro:env/server";',
      'const getSecret = (_name: string) => "test-key";'
    )
    .replace(
      '"blume/core/request-body.ts"',
      JSON.stringify(
        pathToFileURL(join(PKG_ROOT, "src/core/request-body.ts")).href
      )
    )
    .replace('from "ai";', `from ${JSON.stringify(resolve("ai"))};`)
    .replace(
      'from "@ai-sdk/openai-compatible";',
      `from ${JSON.stringify(resolve("@ai-sdk/openai-compatible"))};`
    );
  const dir = await mkdtemp(join(tmpdir(), "blume-ask-abort-"));
  dirs.push(dir);
  const file = join(dir, "ask.ts");
  await writeFile(file, source, "utf-8");
  // SAFETY: the generated route exports its handler as `POST`.
  const route = (await import(file)) as { POST: AskRoute };
  return route.POST;
};

describe("the generated assistant route", () => {
  it("stops the model call when the reader closes the panel, without logging an error", async () => {
    const POST = await loadRoute();
    const reader = new AbortController();
    const response = await POST({
      request: new Request("http://localhost/api/ask", {
        body: JSON.stringify({ messages: [{ content: "hi", role: "user" }] }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: reader.signal,
      }),
    });
    expect(response.status).toBe(200);
    const text = response.body?.pipeThrough(new TextDecoderStream());
    if (!text) {
      throw new Error("The route answered without a body.");
    }
    const answer = text[Symbol.asyncIterator]();
    const first = await answer.next();
    expect(first.value).toBe("Hello");

    // The reader closes the panel: the client aborts its request.
    reader.abort();

    // The provider's request to the model is cancelled rather than left to
    // generate (and bill) to completion (a hang here times the test out),
    // and the answer stream ends.
    expect(await upstreamAborted.promise).toBe(true);
    const rest = await answer.next();
    expect(rest.done).toBe(true);
    // A reader leaving is not a provider failure.
    expect(
      errorSpy.mock.calls.filter(
        ([message]) => message === "Assistant provider error:"
      )
    ).toEqual([]);
  });
});
