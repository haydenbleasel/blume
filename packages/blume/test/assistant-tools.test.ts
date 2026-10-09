import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { join } from "pathe";

import {
  askIndex,
  createAskContext,
  readerScope,
} from "../src/ai/ask-context.ts";
import type { AskData } from "../src/ai/ask-context.ts";
import {
  ASK_MAX_STEPS,
  createAskTools,
  readPage,
  searchDocs,
} from "../src/ai/ask-tools.ts";
import { openai, resolveAskBackend } from "../src/ai/ask.ts";
import { askEndpointTemplate } from "../src/astro/templates.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

/**
 * The assistant's docs tools (`src/ai/ask-tools.ts`): searching and reading
 * the snapshot within the reader's scope, and the generated route running a
 * search-then-answer loop against a model that calls them.
 */

const LONG = "Narration reads each page aloud. ".repeat(900);

const DATA: AskData = {
  documents: [
    {
      content: `# Narration\n\nThe player reads pages aloud and highlights each sentence.\n\n## Voices\n\nBrowser voices need no key.`,
      description: "Listen to a page.",
      locale: "en",
      route: "/docs/narration",
      title: "Narration",
    },
    {
      content: "# Erzählung\n\nDer Player liest Seiten vor.",
      description: "",
      locale: "de",
      route: "/de/docs/narration",
      title: "Erzählung",
    },
    {
      content: LONG,
      description: "",
      locale: "en",
      route: "/docs/long",
      title: "Long page",
    },
  ],
  site: "https://docs.example.com",
};

const byRoute = new Map(DATA.documents.map((doc) => [doc.route, doc]));

describe(searchDocs, () => {
  it("returns excerpts headed by title and route, within the reader's locale", async () => {
    const english = readerScope(DATA, byRoute, { path: "/docs/narration" });
    const result = await searchDocs(DATA, english, "highlights sentence");
    expect(result).toContain("## [Narration](/docs/narration)");
    expect(result).not.toContain("Erzählung");
    const german = readerScope(DATA, byRoute, { path: "/de/docs/narration" });
    expect(await searchDocs(DATA, german, "Player Seiten")).toContain(
      "## [Erzählung](/de/docs/narration)"
    );
  });

  it("says so when nothing matches", async () => {
    const scope = readerScope(DATA, byRoute);
    expect(await searchDocs(DATA, scope, "zzqx")).toBe(
      'No pages matched "zzqx". Try other words, or a broader query.'
    );
  });
});

const localeFrom = (data: AskData, path?: string) =>
  readerScope(data, byRoute, path === undefined ? undefined : { path }).filters
    .locale;

describe(readerScope, () => {
  /** The same snapshot on a site whose default locale is English. */
  const I18N: AskData = { ...DATA, defaultLocale: "en" };

  it("keeps a question from outside the docs to the default locale", () => {
    // The homepage and a custom page aren't in the snapshot, and a
    // cross-origin caller may send no page at all.
    expect(localeFrom(I18N, "/")).toBe("en");
    expect(localeFrom(I18N, "/pricing")).toBe("en");
    expect(localeFrom(I18N)).toBe("en");
    // A single-locale site has nothing to filter.
    expect(localeFrom({ ...DATA, documents: DATA.documents.slice(0, 1) })).toBe(
      undefined
    );
  });

  it("takes the locale a path outside the docs names", () => {
    expect(localeFrom(I18N, "/de")).toBe("de");
    expect(localeFrom(I18N, "/DE/preise/")).toBe("de");
    expect(localeFrom(DATA, "/de")).toBe("de");
  });

  it("scopes the model's own searches the same way", async () => {
    const home = createAskTools(I18N)({ path: "/" });
    const options = { context: {}, messages: [], toolCallId: "1" };
    const english = await home.search_docs?.execute?.(
      { query: "Narration Erzählung" },
      options
    );
    expect(english).toContain("## [Narration](/docs/narration)");
    expect(english).not.toContain("/de/docs/narration");
    const german = await createAskTools(I18N)({
      path: "/de",
    }).search_docs?.execute?.({ query: "Narration Erzählung" }, options);
    expect(german).toContain("## [Erzählung](/de/docs/narration)");
    expect(german).not.toContain("(/docs/narration)");
  });
});

describe(readPage, () => {
  it("reads a page by route, path, or full URL", () => {
    expect(readPage(DATA, byRoute, "/docs/narration")).toStartWith(
      "## [Narration](/docs/narration)\n# Narration"
    );
    expect(readPage(DATA, byRoute, "docs/narration/#voices")).toStartWith(
      "## [Narration](/docs/narration)"
    );
    expect(
      readPage(DATA, byRoute, "https://docs.example.com/docs/narration?x=1")
    ).toStartWith("## [Narration](/docs/narration)");
    // A route as its heading cites it, percent-encoded where it needs it.
    const beta = {
      content: "# Setup",
      description: "",
      locale: "en",
      route: "/docs/setup (beta)",
      title: "Setup",
    };
    expect(
      readPage(DATA, new Map([[beta.route, beta]]), "/docs/setup%20%28beta%29")
    ).toStartWith("## [Setup](/docs/setup%20%28beta%29)");
  });

  it("cuts a long page and names a missing one", () => {
    const long = readPage(DATA, byRoute, "/docs/long");
    expect(long).toEndWith(
      "[The page continues; this is its first 20,000 characters.]"
    );
    expect(readPage(DATA, byRoute, "/nope")).toBe(
      "There is no page at /nope. Use search_docs to find the right one."
    );
    expect(
      readPage(
        { ...DATA, site: null },
        byRoute,
        "https://docs.example.com/docs/narration"
      )
    ).toContain("There is no page at");
    expect(readPage(DATA, byRoute, "https://docs.example.com")).toBe(
      "There is no page at /. Use search_docs to find the right one."
    );
    expect(readPage(DATA, byRoute, "/docs/100%")).toBe(
      "There is no page at /docs/100%. Use search_docs to find the right one."
    );
  });
});

describe(createAskTools, () => {
  it("builds both tools for a request, scoped to the reader's page", async () => {
    const tools = createAskTools(DATA)({ path: "/de/docs/narration" });
    expect(Object.keys(tools).toSorted()).toEqual(["read_page", "search_docs"]);
    const options = { context: {}, messages: [], toolCallId: "1" };
    expect(
      await tools.search_docs?.execute?.({ query: "Player" }, options)
    ).toContain("/de/docs/narration");
    expect(
      await tools.read_page?.execute?.({ route: "/docs/narration" }, options)
    ).toContain("## Voices");
    expect(ASK_MAX_STEPS).toBe(5);
  });
});

describe("grounding with tools", () => {
  it("shares one index per snapshot", () => {
    expect(askIndex(DATA)).toBe(askIndex(DATA));
  });

  it("tells the model about the tools, and still grounds a question nothing matched", async () => {
    const ground = createAskContext(DATA, { tools: true });
    const matched = await ground(
      [{ content: "How do voices work?", role: "user" }],
      { path: "/docs/narration" }
    );
    expect(matched).toContain("call search_docs with a focused query");
    expect(matched).toContain("<docs>");
    const unmatched = await ground([{ content: "zzqx", role: "user" }]);
    expect(unmatched).toContain(
      "No documentation excerpts matched this question up front. Use search_docs to look before you answer."
    );
    // Without tools, nothing matched still means the plain fallback prompt.
    const plain = createAskContext(DATA);
    expect(await plain([{ content: "zzqx", role: "user" }])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End to end: the generated route, a model that calls search_docs
// ---------------------------------------------------------------------------

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

type AskRoute = (context: { request: Request }) => Promise<Response>;

/** A streamed chat-completions delta: text, or a tool call. */
interface CompletionDelta {
  content?: string;
  role?: "assistant";
  tool_calls?: {
    function: { arguments: string; name: string };
    id: string;
    index: number;
    type: "function";
  }[];
}

/** One chat-completions stream event carrying `delta`. */
const completion = (
  delta: CompletionDelta,
  finish: string | null = null
): string =>
  `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finish, index: 0 }],
    created: 0,
    id: "chatcmpl-1",
    model: "m",
    object: "chat.completion.chunk",
  })}\n\n`;

/** The chat-completions request bodies the fake model received. */
const requests: {
  messages: { content?: string; role: string }[];
  tools?: object[];
}[] = [];

// Turn one: call search_docs. Turn two: answer from the tool result.
const upstream = Bun.serve({
  async fetch(request) {
    const body = await request.json();
    requests.push(body);
    const toolResult = body.messages.find(
      (message: { role: string }) => message.role === "tool"
    );
    const stream = toolResult
      ? [
          completion({
            content: `Found it: ${toolResult.content.includes("Browser voices need no key") ? "no key needed" : "nothing"}.`,
            role: "assistant",
          }),
          completion({}, "stop"),
          "data: [DONE]\n\n",
        ]
      : [
          completion({
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({ query: "browser voices key" }),
                  name: "search_docs",
                },
                id: "call_1",
                index: 0,
                type: "function",
              },
            ],
          }),
          completion({}, "tool_calls"),
          "data: [DONE]\n\n",
        ];
    return new Response(stream.join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
  port: 0,
});

const dirs: string[] = [];

afterAll(async () => {
  await upstream.stop(true);
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const resolve = (specifier: string): string =>
  JSON.stringify(pathToFileURL(Bun.resolveSync(specifier, PKG_ROOT)).href);

const loadRoute = async (): Promise<AskRoute> => {
  const parsed = blumeConfigSchema.parse({
    ai: {
      assistant: {
        enabled: true,
        provider: openai({
          apiKeyEnv: "TEST_KEY",
          baseUrl: `http://localhost:${upstream.port}/v1`,
          model: "m",
        }),
        tools: true,
      },
    },
  });
  const backend = resolveAskBackend(parsed.ai.assistant?.provider);
  // An OpenAI-compatible backend leaves the tools off unless asked.
  expect(backend.toolsByDefault).toBe(false);
  const dir = await mkdtemp(join(tmpdir(), "blume-ask-tools-"));
  dirs.push(dir);
  const dataFile = join(dir, "ask-data.json");
  await writeFile(dataFile, JSON.stringify(DATA), "utf-8");
  const source = askEndpointTemplate(backend, {
    tools: parsed.ai.assistant?.tools,
  })
    .replace(
      'import { getSecret } from "astro:env/server";',
      'const getSecret = (_name: string) => "test-key";'
    )
    .replace(
      'import askData from "blume:ask-data";',
      `import askData from ${JSON.stringify(pathToFileURL(dataFile).href)} with { type: "json" };`
    )
    .replaceAll(/"blume\/(?<path>[^"]+)"/gu, (_match, path: string) =>
      JSON.stringify(pathToFileURL(join(PKG_ROOT, "src", path)).href)
    )
    .replaceAll('from "ai";', `from ${resolve("ai")};`)
    .replace(
      'from "@ai-sdk/openai-compatible";',
      `from ${resolve("@ai-sdk/openai-compatible")};`
    );
  expect(source).toContain("stopWhen: stepCountIs(ASK_MAX_STEPS)");
  const file = join(dir, "ask.ts");
  await writeFile(file, source, "utf-8");
  // SAFETY: the generated route exports its handler as `POST`.
  const route = (await import(file)) as { POST: AskRoute };
  return route.POST;
};

describe("the generated assistant route with tools", () => {
  it("lets the model search the docs, then answers from what it found", async () => {
    const POST = await loadRoute();
    const response = await POST({
      request: new Request("http://localhost/api/ask", {
        body: JSON.stringify({
          messages: [{ content: "Do I need a key for voices?", role: "user" }],
          page: { path: "/docs/narration" },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Found it: no key needed.");
    expect(requests).toHaveLength(2);
    // The model was offered both tools, and got the search result back.
    expect(requests[0]?.tools).toHaveLength(2);
    const toolMessage = requests[1]?.messages.find(
      (message) => message.role === "tool"
    );
    expect(toolMessage?.content).toContain("## [Narration](/docs/narration)");
  });
});
