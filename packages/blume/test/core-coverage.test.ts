import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { discoverFolderMeta } from "../src/core/meta.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { serverFeatures } from "../src/core/server-features.ts";
import { buildReferenceFiles } from "../src/openapi/scalar.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

describe("scalar reference builder", () => {
  it("maps the dark theme mode onto Scalar's darkMode flag", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/openapi.json",
      },
      theme: { mode: "dark" },
    });
    const { files } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    expect(files[0]?.content).toContain('"darkMode": true');
  });

  it("maps the light theme mode onto Scalar's darkMode flag", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/openapi.json",
      },
      theme: { mode: "light" },
    });
    const { files } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    expect(files[0]?.content).toContain('"darkMode": false');
  });

  it("passes an explicit Scalar theme name straight through", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/openapi.json",
        theme: "purple",
      },
    });
    const { files } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    // An override wins, so no accent/customCss is layered on.
    expect(files[0]?.content).toContain('"theme": "purple"');
    expect(files[0]?.content).not.toContain("--scalar-color-accent");
  });

  it("inlines a local spec and warns on a missing one", async () => {
    const root = await tempDir("blume-scalar-");
    await writeFile(
      join(root, "openapi.json"),
      '{"openapi":"3.1.0","info":{"title":"Local"}}'
    );
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        sources: [
          { route: "/ref", spec: "openapi.json" },
          { route: "/missing", spec: "nope.json" },
        ],
      },
    });
    const { files, warnings } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root,
    });

    expect(files).toHaveLength(2);
    const local = files.find((file) => file.pagePath === "ref.astro");
    // The found spec is inlined as `content`.
    expect(local?.content).toContain('"content"');
    expect(local?.content).toContain("3.1.0");
    // The missing spec falls back to a `url` and emits a warning.
    expect(warnings.some((w) => w.includes("not found"))).toBe(true);
  });

  it("derives slugged routes for multiple labeled sources", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        sources: [
          { label: "Public API", spec: "https://x.dev/a.json" },
          { label: "Admin API", spec: "https://x.dev/b.json" },
        ],
      },
    });
    const { files } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    expect(files.map((file) => file.pagePath).toSorted()).toStrictEqual([
      "reference/admin-api.astro",
      "reference/public-api.astro",
    ]);
  });

  it("skips a reference whose route collides with a content page", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/a.json",
      },
    });
    const { files, warnings } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(["/reference"]),
      root: "/r",
    });
    expect(files).toStrictEqual([]);
    expect(
      warnings.some((w) => w.includes("collides with a content page"))
    ).toBe(true);
  });

  it("keeps the first of two sources that resolve to the same route", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        sources: [
          { route: "/dup", spec: "https://x.dev/a.json" },
          { route: "/dup", spec: "https://x.dev/b.json" },
        ],
      },
    });
    const { files, warnings } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    expect(files).toHaveLength(1);
    expect(warnings.some((w) => w.includes("resolve to /dup"))).toBe(true);
  });
});

describe("folder meta discovery", () => {
  it("reports invalid meta and meta that fails to load", async () => {
    const root = await tempDir("blume-meta-");
    await mkdir(join(root, "invalid"), { recursive: true });
    await mkdir(join(root, "broken"), { recursive: true });
    // `order` must be a number, so this fails schema validation.
    await writeFile(
      join(root, "invalid", "meta.ts"),
      'export default { order: "nope" };\n'
    );
    // A module that throws when evaluated fails to load.
    await writeFile(
      join(root, "broken", "meta.ts"),
      'throw new Error("boom");\nexport default {};\n'
    );

    const { diagnostics, meta } = await discoverFolderMeta(root);
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("BLUME_META_INVALID");
    expect(codes).toContain("BLUME_META_LOAD_FAILED");
    // Neither bad file lands in the resolved meta map.
    expect(meta.size).toBe(0);
  });
});

describe("server features", () => {
  it("lists every enabled server-only feature", () => {
    const config = blumeConfigSchema.parse({
      ai: { ask: { enabled: true } },
      mcp: { enabled: true },
      search: { mixedbread: { storeId: "store-1" }, provider: "mixedbread" },
    });
    expect(serverFeatures(config)).toStrictEqual([
      "Ask AI",
      "MCP server",
      "Search (mixedbread)",
    ]);
  });

  it("returns nothing for a fully static project", () => {
    expect(serverFeatures(blumeConfigSchema.parse({}))).toStrictEqual([]);
  });
});

describe("i18n schema validation", () => {
  it("rejects a defaultLocale that is not a configured locale", () => {
    const result = blumeConfigSchema.safeParse({
      i18n: {
        defaultLocale: "de",
        locales: [{ code: "en", label: "English" }],
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.issues.map((issue) => issue.message)
    ).toContainEqual(expect.stringContaining("i18n.defaultLocale"));
  });

  it("rejects a fallbackLocale that is not a configured locale", () => {
    const result = blumeConfigSchema.safeParse({
      i18n: {
        defaultLocale: "en",
        fallbackLocale: "de",
        locales: [{ code: "en", label: "English" }],
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.issues.map((issue) => issue.message)
    ).toContainEqual(expect.stringContaining("i18n.fallbackLocale"));
  });
});

describe("config schema validators", () => {
  it("parses sidebar items through the recursive lazy union", () => {
    const config = blumeConfigSchema.parse({
      navigation: {
        sidebar: ["intro", { items: ["a", "b"], label: "Group" }],
      },
    });
    expect(config.navigation.sidebar.items).toHaveLength(2);
  });

  it("rejects an unknown font slug", () => {
    const result = blumeConfigSchema.safeParse({
      theme: { fonts: { body: "definitely-not-a-real-font" } },
    });
    expect(result.success).toBe(false);
  });

  it("requires credentials for a hosted search provider", () => {
    const result = blumeConfigSchema.safeParse({
      search: { provider: "algolia" },
    });
    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.issues.map((issue) => issue.message)
    ).toContainEqual(expect.stringContaining("search.algolia"));
  });

  it("requires a baseUrl for an openai-compatible Ask AI backend", () => {
    const result = blumeConfigSchema.safeParse({
      ai: { ask: { enabled: true, provider: "openai-compatible" } },
    });
    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.issues.map((issue) => issue.message)
    ).toContainEqual(expect.stringContaining("ai.ask.baseUrl"));
  });

  it("accepts a custom content source via the ContentSource validator", () => {
    const result = blumeConfigSchema.safeParse({
      content: {
        sources: [
          { source: { load: () => ({}), name: "demo" }, type: "custom" },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});
