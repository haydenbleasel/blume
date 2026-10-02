import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { anthropic, gateway, openai, openrouter } from "../src/ai/ask.ts";
import {
  assistantProviderDependencies,
  deploymentAdapterDependencies,
  islandFrameworkDependencies,
  missingDependencyDiagnostic,
  missingRuntimeDependencies,
  narrationProviderDependencies,
  searchProviderDependencies,
} from "../src/astro/runtime-deps.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import { cloudflare } from "../src/deploy/adapters/index.ts";
import { algolia, flexsearch, orama } from "../src/search/adapters/index.ts";

// An empty temp dir stands in for both the project root and the Blume package,
// so an adapter's SDK resolves from neither. Its empty `node_modules` also
// stops Bun resolving a package out of its global install cache, which it
// does for any bare specifier under a root that has no `node_modules` at all.
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-runtime-deps-"));
  await mkdir(join(root, "node_modules"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

// A parsed (schema-defaulted) `ai.assistant` block, the shape the check receives
// from the resolved config.
const parsedAsk = (
  ask: NonNullable<NonNullable<BlumeConfigInput["ai"]>["assistant"]>
) => blumeConfigSchema.parse({ ai: { assistant: ask } }).ai.assistant;

describe("searchProviderDependencies", () => {
  it("reports the search adapter's SDK when it isn't installed anywhere", () => {
    expect(searchProviderDependencies(flexsearch(), root, root)).toEqual([
      {
        dep: "flexsearch",
        install: ["flexsearch"],
        owner: 'Search adapter "flexsearch"',
      },
    ]);
  });

  it("stays quiet when the adapter's SDK ships with Blume", () => {
    expect(searchProviderDependencies(orama(), root)).toEqual([]);
  });
});

describe("assistantProviderDependencies", () => {
  it("reports the assistant provider SDK when it isn't installed anywhere", () => {
    const ask = parsedAsk({
      enabled: true,
      provider: openrouter({ model: "x/y" }),
    });
    expect(assistantProviderDependencies(ask, root, root)).toEqual([
      {
        dep: "@openrouter/ai-sdk-provider",
        install: ["@openrouter/ai-sdk-provider"],
        owner: 'Assistant provider "openrouter"',
      },
    ]);
  });

  it("stays quiet for the gateway backend, an external endpoint, and a disabled assistant", () => {
    // Gateway needs only the core `ai` package, which ships with Blume.
    expect(
      assistantProviderDependencies(parsedAsk({ enabled: true }), root, root)
    ).toEqual([]);
    // An external endpoint means the provider route is never generated.
    expect(
      assistantProviderDependencies(
        parsedAsk({
          enabled: true,
          endpoint: "https://api.example.com/ask",
          provider: openrouter({ model: "x/y" }),
        }),
        root,
        root
      )
    ).toEqual([]);
    expect(assistantProviderDependencies(undefined, root, root)).toEqual([]);
  });

  it("stays quiet when the assistant provider SDK is resolvable", () => {
    // Blume's own package resolves the workspace-installed SDKs: the
    // OpenAI-compatible one for a custom endpoint, and each direct
    // provider's own.
    for (const provider of [
      openai({
        apiKeyEnv: "K",
        baseUrl: "https://api.example.com/v1",
        model: "m",
      }),
      openai({ model: "m" }),
      anthropic({ model: "m" }),
    ]) {
      const ask = parsedAsk({ enabled: true, provider });
      expect(assistantProviderDependencies(ask, root)).toEqual([]);
    }
  });
});

describe("narrationProviderDependencies", () => {
  it("reports @ai-sdk/openai for openai(), with or without a baseUrl", () => {
    for (const provider of [
      openai({ model: "gpt-4o-mini-tts" }),
      openai({ baseUrl: "http://localhost:8880/v1", model: "kokoro" }),
    ]) {
      const { narration } = blumeConfigSchema.parse({
        narration: { provider },
      });
      expect(narrationProviderDependencies(narration, root, root)).toEqual([
        {
          dep: "@ai-sdk/openai",
          install: ["@ai-sdk/openai"],
          owner: 'Narration provider "openai"',
        },
      ]);
    }
  });

  it("stays quiet for gateway(), browser voices, and narration turned off", () => {
    for (const narration of [
      { provider: gateway() },
      true,
      { enabled: false, provider: openai({ model: "gpt-4o-mini-tts" }) },
    ]) {
      expect(
        narrationProviderDependencies(
          blumeConfigSchema.parse({ narration }).narration,
          root,
          root
        )
      ).toEqual([]);
    }
  });
});

describe("deploymentAdapterDependencies", () => {
  it("reports the cloudflare adapter package when it isn't installed anywhere", () => {
    const { deployment } = blumeConfigSchema.parse({
      deployment: cloudflare(),
    });
    expect(deploymentAdapterDependencies(deployment, root, root)).toEqual([
      {
        dep: "@astrojs/cloudflare",
        install: ["@astrojs/cloudflare"],
        owner: 'Deployment adapter "cloudflare"',
      },
    ]);
  });
});

describe("islandFrameworkDependencies", () => {
  it("installs a Vue/Svelte island's framework beside its integration", () => {
    expect(islandFrameworkDependencies(["react", "vue"], root)).toEqual([
      {
        dep: "@astrojs/vue",
        install: ["@astrojs/vue", "vue"],
        owner: 'Island framework "vue"',
      },
    ]);
  });
});

describe("missingDependencyDiagnostic", () => {
  const config = blumeConfigSchema.parse({
    ai: {
      assistant: { enabled: true, provider: openrouter({ model: "x/y" }) },
    },
    narration: {
      provider: openai({
        baseUrl: "http://localhost:8880/v1",
        model: "kokoro",
      }),
    },
    search: algolia({ apiKey: "k", appId: "a", indexName: "i" }),
  });

  it("returns nothing when every package resolves", async () => {
    expect(
      await missingDependencyDiagnostic(
        blumeConfigSchema.parse({}),
        root,
        "error"
      )
    ).toBeUndefined();
  });

  it("names one missing package and its install command", async () => {
    await writeFile(join(root, "package-lock.json"), "{}\n");
    const single = blumeConfigSchema.parse({
      search: algolia({ apiKey: "k", appId: "a", indexName: "i" }),
    });
    expect(
      await missingDependencyDiagnostic(single, root, "warning", [], root)
    ).toEqual({
      code: "BLUME_DEPENDENCY_MISSING",
      message:
        'Search adapter "algolia" needs "algoliasearch", which isn\'t installed.',
      severity: "warning",
      suggestion: "Install it: `npm install algoliasearch`.",
    });
  });

  it("lists every missing package in one project-package-manager command", async () => {
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(
      await missingDependencyDiagnostic(config, root, "error", ["svelte"], root)
    ).toEqual({
      code: "BLUME_DEPENDENCY_MISSING",
      message:
        'These packages aren\'t installed: Search adapter "algolia" needs "algoliasearch"; Assistant provider "openrouter" needs "@openrouter/ai-sdk-provider"; Narration provider "openai" needs "@ai-sdk/openai"; Island framework "svelte" needs "@astrojs/svelte".',
      severity: "error",
      suggestion:
        "Install them: `pnpm add algoliasearch @openrouter/ai-sdk-provider @ai-sdk/openai @astrojs/svelte svelte`.",
    });
  });

  it("checks every adapter the resolved config names", () => {
    expect(
      missingRuntimeDependencies(config, root, [], root).map(({ dep }) => dep)
    ).toEqual([
      "algoliasearch",
      "@openrouter/ai-sdk-provider",
      "@ai-sdk/openai",
    ]);
  });
});
