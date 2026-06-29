import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

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
import type { PageRecord } from "../src/core/types.ts";

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

describe("buildRawMarkdown", () => {
  it("maps every route to its raw (frontmatter-included) source", async () => {
    const raw = await buildRawMarkdown(project());
    expect(raw["/a"]).toBe(sources.get("a.md") ?? "");
    expect(raw["/b"]).toBe(sources.get("b.md") ?? "");
    expect(raw["/a"]).toContain("title: Alpha");
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
  it("emits the plain gateway endpoint with no provider SDK", () => {
    const out = askEndpointTemplate(resolveAskBackend());
    expect(out).toContain('import { streamText } from "ai";');
    expect(out).not.toContain("@openrouter/ai-sdk-provider");
    expect(out).not.toContain("@ai-sdk/openai-compatible");
    expect(out).toContain('model: "openai/gpt-5.5"');
  });

  it("wires the OpenRouter provider and its env var", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(
        askConfig({ model: "anthropic/x", provider: "openrouter" })
      )
    );
    expect(out).toContain(
      'import { createOpenRouter } from "@openrouter/ai-sdk-provider";'
    );
    expect(out).toContain('process.env["OPENROUTER_API_KEY"]');
    expect(out).toContain('model: openrouter("anthropic/x")');
  });

  it("wires the OpenAI-compatible provider with the preset base URL", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(askConfig({ provider: "llmgateway" }))
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
