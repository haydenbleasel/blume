import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { createAskContext } from "../src/ai/ask-context.ts";
import type { AskData } from "../src/ai/ask-context.ts";
import { buildAskData } from "../src/ai/ask-data.ts";
import { askBackendRuntimeDep, resolveAskBackend } from "../src/ai/ask.ts";
import { buildLlmsFiles } from "../src/ai/llms.ts";
import { buildRawMarkdown } from "../src/ai/markdown.ts";
import {
  askEndpointTemplate,
  runtimeDependencies,
} from "../src/astro/templates.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { AskAiConfig } from "../src/core/schema.ts";
import type { PageRecord, RouteManifestEntry } from "../src/core/types.ts";

/** Parse an `ai.ask` block through the full schema so defaults are applied. */
const askConfig = (ask: Record<string, unknown>): AskAiConfig =>
  blumeConfigSchema.parse({ ai: { ask } }).ai.ask as AskAiConfig;

/** The runtime deps declared for a given `ai.ask` block (or default config). */
const runtimeDeps = (ask?: Record<string, unknown>): string[] =>
  runtimeDependencies({
    config: blumeConfigSchema.parse(ask ? { ai: { ask } } : {}),
    needsReact: false,
  });

let root: string;
const sources = new Map<string, string>();

const makePage = (
  id: string,
  route: string,
  title: string,
  over: Partial<PageRecord> = {}
): PageRecord => ({
  contentType: "doc",
  format: "md",
  groups: [],
  headings: [],
  id,
  links: [],
  locale: "",
  meta: pageMetaSchema.parse({}),
  navPath: id,
  route,
  segments: [],
  source: { name: "filesystem", ref: id },
  sourcePath: join(root, id),
  title,
  translationKey: route,
  ...over,
});

const makeProject = (pages: PageRecord[]): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://example.com/" },
      description: "Desc",
      title: "Docs",
    }),
    graph: { pages },
    manifest: {
      routes: pages.map((page) => ({
        path: page.route,
        sourcePath: page.sourcePath,
      })),
    },
  }) as unknown as BlumeProject;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-ai-"));
  const files: Record<string, string> = {
    "a.md": "---\ntitle: Alpha\n---\n# Alpha\n\nBody A.\n",
    "b.md": "---\ntitle: Beta\n---\n# Beta\n\nBody B.\n",
    "c.md": "---\ntitle: Gamma\n---\n# Gamma\n\nDraft body.\n",
  };
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      sources.set(rel, content);
      await writeFile(join(root, rel), content);
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const project = (): BlumeProject =>
  makeProject([
    makePage("b.md", "/b", "Beta"),
    makePage("a.md", "/a", "Alpha", { description: "First" }),
    makePage("c.md", "/c", "Gamma", {
      meta: pageMetaSchema.parse({ draft: true }),
    }),
  ]);

describe("buildLlmsFiles — index", () => {
  it("lists non-draft pages in route order with absolute links", async () => {
    const { index } = await buildLlmsFiles(project());
    expect(index).toContain("# Docs");
    expect(index).toContain("> Desc");
    const links = index.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toStrictEqual([
      "- [Alpha](https://example.com/a): First",
      "- [Beta](https://example.com/b)",
    ]);
    expect(index).not.toContain("Gamma");
  });
});

describe("buildLlmsFiles — full", () => {
  it("emits each page body with its source URL, excluding drafts", async () => {
    const { full } = await buildLlmsFiles(project());
    expect(full).toContain("Source: https://example.com/a");
    expect(full).toContain("Body A.");
    expect(full).toContain("Body B.");
    // The section separator joins page bodies.
    expect(full).toContain("\n---\n");
    expect(full).not.toContain("Draft body.");
  });
});

const sitelessProject = (): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({ title: "Docs" }),
    graph: {
      pages: [makePage("a.md", "/a", "Alpha", { description: "First" })],
    },
    manifest: { routes: [{ path: "/a", sourcePath: join(root, "a.md") }] },
  }) as unknown as BlumeProject;

describe("buildLlmsFiles — without a deployment site", () => {
  it("emits root-relative links when no site is configured", async () => {
    const { full, index } = await buildLlmsFiles(sitelessProject());
    expect(index).toContain("- [Alpha](/a): First");
    expect(full).toContain("Source: /a");
    expect(index).not.toContain("https://");
  });
});

describe("buildRawMarkdown", () => {
  it("maps every route to its raw (frontmatter-included) source", async () => {
    const raw = await buildRawMarkdown(project());
    expect(raw["/a"]).toBe(sources.get("a.md") ?? "");
    expect(raw["/b"]).toBe(sources.get("b.md") ?? "");
    expect(raw["/a"]).toContain("title: Alpha");
  });
});

/** A route manifest entry backed by one of the temp fixture files. */
const askRoute = (over: Partial<RouteManifestEntry>): RouteManifestEntry =>
  ({
    contentType: "doc",
    draft: false,
    hidden: false,
    id: "a.md",
    indexable: true,
    locale: "",
    path: "/a",
    sourcePath: join(root, "a.md"),
    title: "Alpha",
    ...over,
  }) as RouteManifestEntry;

const askDataProject = (): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://example.com/" },
      title: "Docs",
    }),
    graph: {
      pages: [
        makePage("a.md", "/a", "Alpha", { description: "First" }),
        makePage("b.md", "/b", "Beta"),
      ],
    },
    manifest: {
      routes: [
        askRoute({ id: "a.md", path: "/a", title: "Alpha" }),
        askRoute({ id: "b.md", path: "/b", title: "Beta" }),
      ],
    },
  }) as unknown as BlumeProject;

describe("buildAskData", () => {
  it("indexes page bodies with locale and the deployment site", async () => {
    const data = await buildAskData(askDataProject());
    expect(data.site).toBe("https://example.com/");
    const alpha = data.documents.find((doc) => doc.route === "/a");
    expect(alpha?.title).toBe("Alpha");
    expect(alpha?.content).toContain("Body A.");
    expect(alpha).toHaveProperty("locale", "");
  });
});

const askData: AskData = {
  documents: [
    {
      content:
        "Install Blume with your package manager, then run the dev server to preview the docs.",
      description: "How to install Blume",
      locale: "",
      route: "/guides/install",
      title: "Installation",
    },
    {
      content:
        "Configure themes, navigation, and search in blume.config.ts to customize the site.",
      description: "Configuration reference",
      locale: "",
      route: "/guides/config",
      title: "Configuration",
    },
  ],
  site: "https://example.com",
};

describe("createAskContext", () => {
  it("grounds the prompt in the retrieved page and asks the model to cite", async () => {
    const ground = createAskContext(askData);
    const system = await ground([
      { content: "how do I install the dev server", role: "user" },
    ]);
    expect(system).toContain("<docs>");
    expect(system).toContain("Installation (/guides/install)");
    expect(system).toContain("run the dev server");
    expect(system).toContain("Cite the page titles");
  });

  it("returns undefined when there is no user message to ground on", async () => {
    const ground = createAskContext(askData);
    expect(await ground([])).toBeUndefined();
    expect(
      await ground([{ content: "hello", role: "assistant" }])
    ).toBeUndefined();
  });

  it("injects the current page as priority context", async () => {
    const ground = createAskContext(askData);
    const system = await ground([{ content: "themes", role: "user" }], {
      path: "/guides/install/",
    });
    expect(system).toContain("the page the user is currently viewing");
    expect(system).toContain("Installation (/guides/install)");
  });

  it("filters retrieval to the current page's locale", async () => {
    const ground = createAskContext({
      documents: [
        {
          content: "installation guide in english",
          description: "",
          locale: "en",
          route: "/en/install",
          title: "Install EN",
        },
        {
          content: "installation guide in french",
          description: "",
          locale: "fr",
          route: "/fr/install",
          title: "Install FR",
        },
      ],
      site: null,
    });
    const system = await ground([{ content: "installation", role: "user" }], {
      path: "/fr/install",
    });
    expect(system).toContain("Install FR");
    expect(system).not.toContain("Install EN");
  });

  it("truncates long excerpts and returns undefined for an empty corpus", async () => {
    const long = "word ".repeat(1000);
    const grounded = createAskContext({
      documents: [
        {
          content: long,
          description: "",
          locale: "",
          route: "/big",
          title: "Big",
        },
      ],
      site: null,
    });
    const system = await grounded([{ content: "word", role: "user" }]);
    expect(system).toContain("…");
    expect((system ?? "").length).toBeLessThan(long.length);

    const empty = createAskContext({ documents: [], site: null });
    expect(
      await empty([{ content: "anything", role: "user" }])
    ).toBeUndefined();
  });
});

describe("resolveAskBackend", () => {
  it("defaults to the gateway backend when ask is unset", () => {
    expect(resolveAskBackend()).toStrictEqual({
      kind: "gateway",
      model: "openai/gpt-5.5",
    });
  });

  it("uses the dedicated provider and preset env var for openrouter", () => {
    const backend = resolveAskBackend(
      askConfig({ enabled: true, model: "anthropic/x", provider: "openrouter" })
    );
    expect(backend).toStrictEqual({
      apiKeyEnv: "OPENROUTER_API_KEY",
      kind: "openrouter",
      model: "anthropic/x",
    });
  });

  it("maps the OpenAI-compatible providers to their presets", () => {
    expect(
      resolveAskBackend(askConfig({ provider: "llmgateway" }))
    ).toMatchObject({
      apiKeyEnv: "LLMGATEWAY_API_KEY",
      baseUrl: "https://api.llmgateway.io/v1",
      kind: "openai-compatible",
      name: "llmgateway",
    });
    expect(resolveAskBackend(askConfig({ provider: "inkeep" }))).toMatchObject({
      apiKeyEnv: "INKEEP_API_KEY",
      baseUrl: "https://api.inkeep.com/v1",
      kind: "openai-compatible",
      name: "inkeep",
    });
  });

  it("honors baseUrl and apiKeyEnv overrides", () => {
    expect(
      resolveAskBackend(
        askConfig({
          apiKeyEnv: "MY_KEY",
          baseUrl: "https://proxy.example/v1",
          provider: "llmgateway",
        })
      )
    ).toMatchObject({
      apiKeyEnv: "MY_KEY",
      baseUrl: "https://proxy.example/v1",
    });
  });

  it("carries the user baseUrl through for openai-compatible", () => {
    expect(
      resolveAskBackend(
        askConfig({
          apiKeyEnv: "GW_KEY",
          baseUrl: "https://gw.example/v1",
          provider: "openai-compatible",
        })
      )
    ).toStrictEqual({
      apiKeyEnv: "GW_KEY",
      baseUrl: "https://gw.example/v1",
      kind: "openai-compatible",
      model: "openai/gpt-5.5",
      name: "openai-compatible",
    });
  });
});

describe("ai.ask schema", () => {
  it("requires baseUrl for the openai-compatible provider", () => {
    expect(() =>
      blumeConfigSchema.parse({
        ai: { ask: { enabled: true, provider: "openai-compatible" } },
      })
    ).toThrow(/ai\.ask\.baseUrl is required/u);
  });

  it("accepts openai-compatible with a baseUrl", () => {
    expect(() =>
      blumeConfigSchema.parse({
        ai: {
          ask: {
            baseUrl: "https://gw.example/v1",
            enabled: true,
            provider: "openai-compatible",
          },
        },
      })
    ).not.toThrow();
  });
});

describe("askEndpointTemplate", () => {
  it("grounds the gateway endpoint and imports the retrieval helper", () => {
    const out = askEndpointTemplate(resolveAskBackend(), true);
    expect(out).toContain('import { streamText } from "ai";');
    expect(out).not.toContain("@openrouter/ai-sdk-provider");
    expect(out).not.toContain("@ai-sdk/openai-compatible");
    expect(out).toContain('model: "openai/gpt-5.5"');
    expect(out).toContain(
      'import { createAskContext } from "blume/ai/ask-context.ts";'
    );
    // The endpoint lives at `src/pages/api/ask.ts`; the data at
    // `src/generated/ask-data.json` — so the import must climb two levels.
    expect(out).toContain(
      'import askData from "../../generated/ask-data.json";'
    );
    expect(out).toContain("const ground = createAskContext(askData);");
    expect(out).toContain("await ground(messages, body.page)");
    // Hardened: validates the body, caps it, and handles stream errors.
    expect(out).toContain("await request.json().catch(() => null)");
    expect(out).toContain("Array.isArray(raw)");
    // Only user/assistant roles pass — a caller can't inject a system prompt
    // and repurpose the endpoint as an open LLM proxy.
    expect(out).toContain('m.role === "user" || m.role === "assistant"');
    expect(out).toContain('typeof m.content === "string"');
    expect(out).toContain("status: 400");
    expect(out).toContain("status: 500");
  });

  it("leaves the Inkeep endpoint ungrounded (it runs its own retrieval)", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(askConfig({ provider: "inkeep" })),
      false
    );
    expect(out).toContain(
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";'
    );
    expect(out).not.toContain("createAskContext");
    expect(out).not.toContain("ask-data.json");
    expect(out).toContain("await request.json().catch(() => null)");
    expect(out).toContain("Answer using the project's documentation.");
  });

  it("wires the OpenRouter provider and its env var", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(
        askConfig({ model: "anthropic/x", provider: "openrouter" })
      ),
      true
    );
    expect(out).toContain(
      'import { createOpenRouter } from "@openrouter/ai-sdk-provider";'
    );
    expect(out).toContain('process.env["OPENROUTER_API_KEY"]');
    expect(out).toContain('model: openrouter("anthropic/x")');
  });

  it("wires the OpenAI-compatible provider with the preset base URL", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(askConfig({ provider: "llmgateway" })),
      true
    );
    expect(out).toContain(
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";'
    );
    expect(out).toContain('baseURL: "https://api.llmgateway.io/v1"');
    expect(out).toContain('process.env["LLMGATEWAY_API_KEY"]');
  });
});

describe("ask backend runtime dependency", () => {
  it("adds no provider dep for the gateway backend", () => {
    expect(askBackendRuntimeDep()).toBeUndefined();
    expect(runtimeDeps({ enabled: true })).not.toContain(
      "@ai-sdk/openai-compatible"
    );
  });

  it("declares the dedicated SDK only when its backend is enabled", () => {
    expect(runtimeDeps({ enabled: true, provider: "openrouter" })).toContain(
      "@openrouter/ai-sdk-provider"
    );
    expect(
      runtimeDeps({
        baseUrl: "https://x/v1",
        enabled: true,
        provider: "openai-compatible",
      })
    ).toContain("@ai-sdk/openai-compatible");
  });

  it("declares nothing when Ask AI is disabled", () => {
    expect(
      runtimeDeps({ enabled: false, provider: "openrouter" })
    ).not.toContain("@openrouter/ai-sdk-provider");
  });
});
