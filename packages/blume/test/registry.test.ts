import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join, relative } from "pathe";

import { inkeep, openrouter, resolveAskBackend } from "../src/ai/ask.ts";
import { askEndpointTemplate } from "../src/astro/templates.ts";
import { packageRoot } from "../src/core/package-root.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { memory } from "../src/ratelimit/index.ts";
import { blumeSourceGlob, eject } from "../src/registry/eject.ts";
import { findItem, packageSrc, registry } from "../src/registry/registry.ts";
import { rewriteImports } from "../src/registry/rewrite-imports.ts";
import { mixedbread } from "../src/search/adapters/index.ts";

const BLUME_SPEC = /["']blume\/(?<path>[^"']+)["']/gu;

// Module specifiers in ejected code: `from "x"`, `import "x"`, and a runtime
// `import("x")` — not a type-only `typeof import("x")`, which never loads.
const IMPORT_SPECIFIER =
  /(?:\bfrom\s+|(?<!typeof\s)\bimport\s*\(\s*|\bimport\s+)["'](?<specifier>[^"']+)["']/gu;
// Specifiers that name no package: relative and absolute paths, Node
// builtins, and Astro's and Blume's virtual modules.
const NON_PACKAGE = /^(?:\.|\/|node:|astro:|blume:|virtual:)/u;
const MODULE_FILE = /\.(?:astro|js|mjs|ts|tsx)$/u;

/** The package a bare specifier names: `@scope/pkg/sub` → `@scope/pkg`. */
const packageOf = (specifier: string): string => {
  const [first = "", second = ""] = specifier.split("/");
  return first.startsWith("@") ? `${first}/${second}` : first;
};

/** Every package the given module files import by bare name, sorted. */
const bareImports = (files: string[]): string[] => {
  const packages = new Set<string>();
  for (const file of files.filter((path) => MODULE_FILE.test(path))) {
    for (const match of readFileSync(file, "utf-8").matchAll(
      IMPORT_SPECIFIER
    )) {
      const specifier = match.groups?.specifier ?? "";
      if (!NON_PACKAGE.test(specifier)) {
        packages.add(packageOf(specifier));
      }
    }
  }
  return [...packages].toSorted();
};

const ejectDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    ejectDirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const writeFiles = async (
  root: string,
  files: Record<string, string>
): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
};

describe("eject", () => {
  it("declares the EPUB bundle, and no AI SDK for an external Ask endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    await writeFiles(root, {
      "blume.config.ts": `export default {
        ai: { assistant: { enabled: true, endpoint: "https://ask.example.com/api" } },
        export: { epub: true },
      };\n`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    const { dependencies, files } = await eject(root);

    // `features.ts` loads the EPUB generator's browser bundle by bare name.
    expect(dependencies).toContain("epub-gen-memory");
    // An external endpoint answers the assistant, so no route imports the AI SDK.
    expect(existsSync(join(root, "src/pages/api/ask.ts"))).toBe(false);
    expect(dependencies).not.toContain("ai");
    expect(
      bareImports(files).filter((name) => !dependencies.includes(name))
    ).toEqual([]);
  });

  it("keeps configured integrations through a portable config bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    await writeFiles(root, {
      "blume.config.ts": `export default {
        integrations: [{ hooks: {}, name: "eject-probe" }],
      };\n`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    const astroConfig = readFileSync(join(root, "astro.config.mjs"), "utf-8");
    expect(astroConfig).toContain("createModuleLoader");
    expect(astroConfig).toContain("...(blumeConfig?.integrations ?? [])");
    const configLoad = astroConfig
      .split("\n")
      .find((line) => line.includes("await loadBlumeConfig"));
    expect(configLoad).toContain('"blume.config.ts"');
    expect(configLoad).not.toContain(root);

    // The docs collection roots at the project-relative content dir, not the
    // absolute path eject ran from.
    const contentConfig = readFileSync(
      join(root, "src", "content.config.ts"),
      "utf-8"
    );
    expect(contentConfig).toContain('base: "docs"');
    expect(contentConfig).not.toContain(root);
    expect(contentConfig).not.toContain("file://");
  });

  it("promotes the runtime, writing every feature-gated file", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);

    // A config that turns on every feature-gated eject branch: the assistant, OG
    // images (via deployment.site), an OpenAPI reference, mixedbread search,
    // and the hosted MCP server.
    await writeFiles(root, {
      "blume.config.ts": `export default {
        agents: { mcp: { enabled: true } },
        ai: {
          assistant: {
            cors: ["https://www.example.com/"],
            enabled: true,
            instructions: "Answer in pirate speak.",
            provider: {
              kind: "openrouter",
              options: { model: "x/y", reasoning: "low" },
              requiredSecrets: ["OPENROUTER_API_KEY"],
              runtimeDeps: ["@openrouter/ai-sdk-provider"],
            },
            retrieval: { contextBudget: 2500, excerptChars: 1200, maxResults: 3 },
          },
        },
        deployment: { site: "https://example.com" },
        reference: [{ kind: "scalar", options: { spec: "openapi.json" }, requiredSecrets: [], runtimeDeps: [] }],
        search: ${JSON.stringify(mixedbread({ storeId: "store-1" }))},
      };\n`,
      // Overrides from components.ts — one static, one hydrated — so eject
      // writes both import forms.
      "components.ts": `import { defineComponents } from "blume";
import Callout from "./components/Callout.astro";
import Tabs from "./components/Tabs.tsx";
export default defineComponents({
  mdx: { Callout, Tabs: { component: Tabs, client: "visible" } },
});
`,
      "components/Callout.astro": "<aside><slot /></aside>\n",
      "components/Tabs.tsx":
        "export default function Tabs() { return null; }\n",
      // A blog post so an RSS feed is produced (alongside the home page).
      "docs/blog/hello.md":
        "---\ntitle: Hello\ntype: blog\ndate: 2024-01-01\n---\n# Hello\n",
      // A changelog entry so the `/changelog` index page is generated.
      "docs/changelog/v1.md":
        "---\ntitle: v1\ntype: changelog\ndate: 2024-02-01\n---\n# v1\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
      // An island and an example so eject materializes their wrappers + maps.
      "examples/demo.tsx": "export default function Demo() { return null; }\n",
      "islands/Counter.tsx": "export default function Counter() {}\n",
      // A local OpenAPI spec inlined into the reference page.
      "openapi.json": '{"openapi":"3.1.0","info":{"title":"API"}}',
      // A custom `.astro` page so the relPages branch runs.
      "pages/custom.astro": "<h1>Custom</h1>\n",
    });

    // A materialized asset under the hidden runtime is copied into public/.
    const assetDir = join(root, ".blume", "public", "blume-assets");
    await mkdir(assetDir, { recursive: true });
    await writeFile(join(assetDir, "img.png"), "png-bytes");

    const { dependencies, files, warnings } = await eject(root);
    const has = (rel: string): boolean => existsSync(join(root, rel));
    const read = (rel: string): string =>
      readFileSync(join(root, rel), "utf-8");

    // Core scaffolding.
    expect(has("astro.config.mjs")).toBe(true);
    expect(has("src/content.config.ts")).toBe(true);
    expect(has("src/pages/[...slug].astro")).toBe(true);
    expect(has("src/generated/data.json")).toBe(true);
    // The runtime data modules stay files after eject (no CLI publishes them
    // in memory), aliased from the ejected config to the snapshots it writes.
    const ejectedConfig = readFileSync(join(root, "astro.config.mjs"), "utf-8");
    expect(ejectedConfig).toContain(
      '"blume:data": fileURLToPath(new URL("./src/generated/data.json", import.meta.url))'
    );
    expect(ejectedConfig).toContain(
      '"blume:mcp-data": fileURLToPath(new URL("./src/generated/mcp-data.json", import.meta.url))'
    );
    expect(ejectedConfig).not.toContain("runtimeModulesPlugin");
    // The include graph the ejected astro.config's includeHmrPlugin reads —
    // without it partial edits would silently serve stale pages post-eject.
    expect(has("src/generated/includes.json")).toBe(true);
    // The component/example maps the catch-all imports, plus their live
    // wrappers; the `islands/` convention plans through the components map.
    expect(has("src/generated/components.ts")).toBe(true);
    expect(has("src/generated/islands.ts")).toBe(false);
    expect(has("src/generated/examples.ts")).toBe(true);
    expect(has("src/generated/component-slots/mdx-Counter.astro")).toBe(true);
    expect(has("src/generated/examples/demo.astro")).toBe(true);
    // Every import in the ejected output is relative to the file holding it,
    // so the app builds from any checkout, not only where eject ran.
    const components = read("src/generated/components.ts");
    expect(components).toContain(
      'import __blumeSlot1 from "../../components/Callout.astro";'
    );
    expect(components).toContain(
      'import __blumeSlot2 from "./component-slots/mdx-Tabs.astro";'
    );
    expect(read("src/generated/component-slots/mdx-Tabs.astro")).toContain(
      'import Component from "../../../components/Tabs.tsx";'
    );
    expect(read("src/generated/component-slots/mdx-Counter.astro")).toContain(
      'import Component from "../../../islands/Counter.tsx";'
    );
    expect(read("src/generated/examples/demo.astro")).toContain(
      'import Example from "../../../examples/demo.tsx";'
    );
    // The ejected config is the project's own now: relative outDir, no
    // "recreated on each run" header, and no path from the machine that ran
    // eject anywhere in it.
    expect(ejectedConfig).toContain('outDir: "./dist"');
    expect(ejectedConfig).toContain('"./pages/**/*.astro"');
    expect(ejectedConfig).not.toContain("Do not edit");
    expect(ejectedConfig).not.toContain(root);
    // The packages the ejected app imports by bare name, for package.json:
    // Astro and its integrations, plus the adapters' own SDKs.
    expect(dependencies).toEqual(
      expect.arrayContaining([
        "astro",
        "@astrojs/mdx",
        "@astrojs/react",
        "@tailwindcss/vite",
        "@openrouter/ai-sdk-provider",
        "blume",
        // React renders the islands and the assistant, so the app depends on it.
        "react",
        "react-dom",
        // The assistant route streams through the AI SDK by bare name.
        "ai",
      ])
    );
    // Every package an ejected file imports by bare name is one the app now
    // depends on: under a strict linker such as pnpm nothing else makes it
    // resolvable, so a gap here is an `astro build` that fails after eject.
    expect(
      bareImports(files).filter((name) => !dependencies.includes(name))
    ).toEqual([]);

    // Feature-gated endpoints: the assistant, OG images, mixedbread search, the RSS
    // feed, and the OpenAPI reference page.
    expect(has("src/pages/api/ask.ts")).toBe(true);
    // The custom `ai.assistant.instructions` survive ejection in the endpoint's
    // system prompt (they were previously dropped on this path), as do the
    // configured `ai.assistant.retrieval` sizes.
    const ejectedAsk = readFileSync(
      join(root, "src/pages/api/ask.ts"),
      "utf-8"
    );
    expect(ejectedAsk).toContain("Answer in pirate speak.");
    expect(ejectedAsk).toContain('"contextBudget":2500');
    expect(ejectedAsk).toContain('"maxResults":3');
    // ...and the `ai.assistant.cors` origins, with their preflight handler.
    expect(ejectedAsk).toContain(
      'const ALLOWED_ORIGINS = ["https://www.example.com"];'
    );
    expect(ejectedAsk).toContain("export const OPTIONS");
    // ...and the adapter, with its own reasoning mapping (OpenRouter's is on
    // the model). The ejected route is byte-for-byte what `blume dev`/`build`
    // generate for the same config, so an eject changes nothing at request
    // time.
    expect(ejectedAsk).toContain(
      'model: openrouter("x/y", { reasoning: { effort: "low" } }),'
    );
    const parsedAsk = blumeConfigSchema.parse({
      ai: {
        assistant: {
          cors: ["https://www.example.com/"],
          enabled: true,
          instructions: "Answer in pirate speak.",
          provider: openrouter({ model: "x/y", reasoning: "low" }),
          retrieval: { contextBudget: 2500, excerptChars: 1200, maxResults: 3 },
        },
      },
    }).ai.assistant;
    const askBackend = resolveAskBackend(parsedAsk?.provider);
    expect(ejectedAsk).toBe(
      askEndpointTemplate(askBackend, {
        cors: parsedAsk?.cors,
        instructions: parsedAsk?.instructions,
        // Rate limiting is on by default.
        rateLimit: memory(),
        retrieval: parsedAsk?.retrieval,
        tools: parsedAsk?.tools ?? askBackend.toolsByDefault,
      })
    );
    expect(has("src/generated/ask-data.json")).toBe(true);
    expect(has("src/pages/og/[...slug].png.ts")).toBe(true);
    expect(has("src/pages/api/search.ts")).toBe(true);
    expect(has("src/pages/[section]/rss.xml.ts")).toBe(true);
    expect(has("src/pages/reference.astro")).toBe(true);
    // The default 404 ships unless a custom page owns the route.
    expect(has("src/pages/404.astro")).toBe(true);

    // The hosted MCP server: data snapshot, endpoint, and both `.well-known`
    // discovery documents, wired into the generated Astro config.
    expect(has("src/generated/mcp-data.json")).toBe(true);
    expect(has("src/pages/mcp.ts")).toBe(true);
    expect(has("src/blume-mcp/discovery.ts")).toBe(true);
    expect(has("src/blume-mcp/server-card.ts")).toBe(true);
    // The changelog index renders the `type: changelog` entry.
    expect(has("src/pages/changelog.astro")).toBe(true);

    // Materialized assets copied across; the hidden runtime is removed.
    expect(has("public/blume-assets/img.png")).toBe(true);
    expect(has(".blume")).toBe(false);

    // The custom page and the MCP discovery routes are wired into the
    // generated Astro config.
    const astroConfig = readFileSync(join(root, "astro.config.mjs"), "utf-8");
    expect(astroConfig).toContain("pages/custom.astro");
    expect(astroConfig).toContain("/.well-known/mcp.json");
    expect(astroConfig).toContain("/.well-known/mcp/server-card.json");

    // The local OpenAPI spec is inlined into the reference page.
    const reference = readFileSync(
      join(root, "src/pages/reference.astro"),
      "utf-8"
    );
    expect(reference).toContain("3.1.0");

    // The mixedbread store id reaches the search endpoint.
    const searchEndpoint = readFileSync(
      join(root, "src/pages/api/search.ts"),
      "utf-8"
    );
    expect(searchEndpoint).toContain("store-1");

    // With no project-local node_modules/blume (a hoisted install), the
    // app.css `@source` glob points at the package's real location instead of
    // silently matching nothing.
    const appCss = readFileSync(join(root, "src/generated/app.css"), "utf-8");
    expect(appCss).toContain(
      `@source "${relative(join(root, "src/generated"), join(packageRoot(), "src"))}/**/*.{astro,ts,tsx}";`
    );
    // The project scan covers `.jsx` islands too: the scan is a file glob,
    // so a class used only in one would otherwise never be generated.
    expect(appCss).toContain('@source "../../**/*.{astro,jsx,mdx,ts,tsx}";');

    // Every returned path was actually written; the local spec resolved, so no
    // reference warnings surface.
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => existsSync(file))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("emits a static search index for a static search provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    // Zero-config defaults to the static Orama provider.
    await writeFiles(root, {
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    expect(existsSync(join(root, "src/generated/search.json"))).toBe(true);
    expect(existsSync(join(root, "src/pages/blume-search.json.ts"))).toBe(true);
  });

  it("ejects an ungrounded adapter's route without a grounding snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    await writeFiles(root, {
      "blume.config.ts": `export default {
        ai: {
          assistant: {
            enabled: true,
            provider: {
              kind: "inkeep",
              options: { model: "inkeep-qa-expert" },
              requiredSecrets: ["INKEEP_API_KEY"],
              runtimeDeps: ["@ai-sdk/openai-compatible"],
            },
          },
        },
      };\n`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);
    const ejectedAsk = readFileSync(
      join(root, "src/pages/api/ask.ts"),
      "utf-8"
    );
    expect(ejectedAsk).toBe(
      askEndpointTemplate(
        resolveAskBackend(
          blumeConfigSchema.parse({
            ai: {
              assistant: {
                enabled: true,
                provider: inkeep({ model: "inkeep-qa-expert" }),
              },
            },
          }).ai.assistant?.provider
        ),
        { rateLimit: memory() }
      )
    );
    expect(ejectedAsk).not.toContain("createAskContext");
    expect(existsSync(join(root, "src/generated/ask-data.json"))).toBe(false);
  });

  it("removes only Blume-owned Ask artifacts in external-endpoint mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    await writeFiles(root, {
      "blume.config.ts": `export default {
        ai: { assistant: { enabled: true, endpoint: "/api/docs/ask" } },
      };\n`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
      "src/generated/ask-data.json": "{}\n",
      "src/pages/api/ask.ts":
        "// Generated by Blume. Do not edit.\nexport {};\n",
    });

    await eject(root);
    expect(existsSync(join(root, "src/pages/api/ask.ts"))).toBe(false);
    expect(existsSync(join(root, "src/generated/ask-data.json"))).toBe(false);

    const custom = "export const POST = () => new Response('custom');\n";
    await writeFiles(root, {
      "src/generated/ask-data.json": "{}\n",
      "src/pages/api/ask.ts": custom,
    });
    await eject(root);
    expect(readFileSync(join(root, "src/pages/api/ask.ts"), "utf-8")).toBe(
      custom
    );
    expect(existsSync(join(root, "src/generated/ask-data.json"))).toBe(false);
  });

  it("preserves an existing tsconfig.json instead of overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    const tuned = '{\n  "compilerOptions": { "strict": true }\n}\n';
    await writeFiles(root, {
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
      "tsconfig.json": tuned,
    });

    const { files } = await eject(root);

    // The user's tuned config is untouched and not reported as ejected.
    expect(readFileSync(join(root, "tsconfig.json"), "utf-8")).toBe(tuned);
    expect(files.some((file) => file.endsWith("tsconfig.json"))).toBe(false);
  });

  it("returns the Scalar reference warnings instead of dropping them", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    // A Scalar reference whose spec file doesn't exist: the page still ships
    // (falling back to loading the spec as a URL, which will 404), so the
    // warning is the only signal — eject must return it like generate does.
    await writeFiles(root, {
      "blume.config.ts": `export default {
        reference: [{ kind: "scalar", options: { spec: "missing.json" }, requiredSecrets: [], runtimeDeps: [] }],
      };\n`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    const { warnings } = await eject(root);

    expect(
      warnings.some((warning) =>
        warning.includes('API reference spec not found: "missing.json"')
      )
    ).toBe(true);
    expect(existsSync(join(root, "src/pages/reference.astro"))).toBe(true);
  });

  it("emits the /changelog page for a release-backed changelog source", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    await writeFiles(root, {
      "blume.config.ts": `export default {
  content: {
    sources: [
      { kind: "filesystem", options: { root: "docs" }, requiredSecrets: [], runtimeDeps: [] },
      { kind: "github-releases", options: { owner: "acme", prefix: "changelog", repo: "sdk" }, requiredSecrets: [], runtimeDeps: [] },
    ],
  },
};\n`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    // The releases API returns no releases: the changelog index must still be
    // ejected so its route (and any nav tab pointing at it) does not 404.
    const originalFetch = globalThis.fetch;
    // SAFETY: the releases source only calls fetch(url) and reads ok/status/
    // json off the real Response; fetch's static properties are never touched.
    globalThis.fetch = ((_input: RequestInfo | URL) =>
      Promise.resolve(
        new Response("[]", {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      )) as typeof fetch;
    try {
      await eject(root);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(existsSync(join(root, "src/pages/changelog.astro"))).toBe(true);
  });

  it("scans an out-of-root examples directory and re-roots user @source paths", async () => {
    // A workspace: the docs app ejects while its examples and the components
    // they import live in a sibling package. The ejected sheets stay portable
    // (relative globs) yet still reach that package.
    const workspace = await mkdtemp(join(tmpdir(), "blume-eject-ws-"));
    ejectDirs.push(workspace);
    const root = join(workspace, "apps", "docs");
    await writeFiles(workspace, {
      "apps/docs/blume.config.ts": `export default {
        examples: {
          css: "../../packages/ui/examples/theme.css",
          source: "../../packages/ui/examples",
        },
      };\n`,
      "apps/docs/docs/index.md": "---\ntitle: Home\n---\n# Home\n",
      "apps/docs/theme.css": '@source "../../packages/ui/src";\n',
      "packages/ui/examples/demo.tsx":
        "export default function Demo() { return null; }\n",
      "packages/ui/examples/theme.css": '@source "../src";\n',
    });

    await eject(root);

    const genDir = join(root, "src/generated");
    const glob = "**/*.{astro,jsx,svelte,ts,tsx,vue}";
    const examplesSheet = readFileSync(join(genDir, "examples.css"), "utf-8");
    expect(examplesSheet).toContain(`@source "../../${glob}";`);
    expect(examplesSheet).toContain(
      `@source "../../../../packages/ui/examples/${glob}";`
    );
    expect(examplesSheet).toContain('@source "../../../../packages/ui/src";');
    const appSheet = readFileSync(join(genDir, "app.css"), "utf-8");
    expect(appSheet).toContain('@source "../../../../packages/ui/src";');
  });

  it("keeps a custom pages/404.astro instead of the default", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);
    await writeFiles(root, {
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
      "pages/404.astro": "<h1>Gone</h1>\n",
    });

    await eject(root);

    // The user's injected `/404` owns the route, so no default is written.
    expect(existsSync(join(root, "src/pages/404.astro"))).toBe(false);
    const astroConfig = readFileSync(join(root, "astro.config.mjs"), "utf-8");
    expect(astroConfig).toContain("pages/404.astro");
  });
});

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-source-"));
  ejectDirs.push(root);
  return root;
};

describe("blumeSourceGlob", () => {
  it("keeps the portable glob when blume is in the project's node_modules", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "node_modules", "blume"), { recursive: true });
    expect(blumeSourceGlob(root, join(root, "src", "generated"))).toBe(
      "../../node_modules/blume/src/**/*.{astro,ts,tsx}"
    );
  });

  it("points at the real install location for a hoisted package", async () => {
    const root = await makeRoot();
    const glob = blumeSourceGlob(root, join(root, "src", "generated"), () =>
      join(root, "..", "hoisted", "node_modules", "blume")
    );
    expect(glob).toBe(
      "../../../hoisted/node_modules/blume/src/**/*.{astro,ts,tsx}"
    );
  });

  it("warns and keeps the default glob when resolution fails", async () => {
    const root = await makeRoot();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const glob = blumeSourceGlob(root, join(root, "src", "generated"), () => {
        throw new Error("no package root");
      });
      expect(glob).toBe("../../node_modules/blume/src/**/*.{astro,ts,tsx}");
      expect(warnings[0]).toContain("could not locate the installed blume");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("registry", () => {
  it("finds a registered item by name", () => {
    const item = findItem("header");
    expect(item?.name).toBe("header");
    expect(item?.files.length).toBeGreaterThan(0);
    expect(item?.postInstall.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown item", () => {
    expect(findItem("does-not-exist")).toBeUndefined();
  });

  it("exposes a non-empty registry", () => {
    expect(registry.length).toBeGreaterThan(0);
  });

  it("offers the overridable layout slots as editable source", () => {
    for (const name of [
      "header",
      "sidebar",
      "breadcrumbs",
      "table-of-contents",
      "pagination",
      "footer",
    ]) {
      expect(findItem(name)?.files[0]?.rewrite).toBe(true);
    }
  });
});

describe("rewriteImports branches", () => {
  const SRC = "/pkg/src";
  const FILE = "/pkg/src/components/layout/Pagination.astro";

  it("rewrites a sibling relative import to a blume/* specifier", () => {
    expect(
      rewriteImports('import x from "./nav-utils.ts";', FILE, SRC)
    ).toContain('from "blume/components/layout/nav-utils.ts"');
  });

  it("keeps a component's self-reference relative", () => {
    const out = rewriteImports(
      'import Self from "./Pagination.astro";',
      FILE,
      SRC
    );
    expect(out).toContain('from "./Pagination.astro"');
    expect(out).not.toContain("blume/");
  });

  it("leaves an import resolving outside src untouched", () => {
    const spec = "../../../outside/y.ts";
    const out = rewriteImports(`import x from "${spec}";`, FILE, SRC);
    expect(out).toContain(`from "${spec}"`);
    expect(out).not.toContain("blume/");
  });
});

describe("registry components", () => {
  const rewritten = registry.filter((item) =>
    item.files.some((file) => file.rewrite)
  );

  for (const item of rewritten) {
    it(`${item.name}: every rewritten import resolves to a real package file`, () => {
      for (const file of item.files) {
        const source = join(packageSrc, file.source);
        expect(existsSync(source)).toBe(true);
        const out = rewriteImports(
          readFileSync(source, "utf-8"),
          source,
          packageSrc
        );
        // A self-contained component may rewrite nothing; any `blume/*` spec it
        // does produce must resolve to a real package file.
        const specs = [...out.matchAll(BLUME_SPEC)].flatMap((match) => {
          const path = match.groups?.path;
          return path ? [path] : [];
        });
        for (const spec of specs) {
          expect(existsSync(join(packageSrc, spec))).toBe(true);
        }
      }
    });
  }
});
