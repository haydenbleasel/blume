import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join, relative } from "pathe";

import { packageRoot } from "../src/core/package-root.ts";
import { blumeSourceGlob, eject } from "../src/registry/eject.ts";
import { findItem, packageSrc, registry } from "../src/registry/registry.ts";
import { rewriteImports } from "../src/registry/rewrite-imports.ts";

const BLUME_SPEC = /["']blume\/(?<path>[^"']+)["']/gu;

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
  it("promotes the runtime, writing every feature-gated file", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eject-"));
    ejectDirs.push(root);

    // A config that turns on every feature-gated eject branch: Ask AI, OG
    // images (via deployment.site), an OpenAPI reference, mixedbread search,
    // and the hosted MCP server.
    await writeFiles(root, {
      "blume.config.ts": `export default {
        ai: { ask: { enabled: true } },
        deployment: { site: "https://example.com" },
        mcp: { enabled: true },
        openapi: { enabled: true, renderer: "scalar", spec: "openapi.json" },
        search: { mixedbread: { storeId: "store-1" }, provider: "mixedbread" },
      };\n`,
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

    const { files, warnings } = await eject(root);
    const has = (rel: string): boolean => existsSync(join(root, rel));

    // Core scaffolding.
    expect(has("astro.config.mjs")).toBe(true);
    expect(has("src/content.config.ts")).toBe(true);
    expect(has("src/pages/[...slug].astro")).toBe(true);
    expect(has("src/generated/data.json")).toBe(true);
    // The island/example maps the catch-all imports, plus their live wrappers.
    expect(has("src/generated/islands.ts")).toBe(true);
    expect(has("src/generated/examples.ts")).toBe(true);
    expect(has("src/generated/islands/Counter.astro")).toBe(true);
    expect(has("src/generated/examples/demo.astro")).toBe(true);

    // Feature-gated endpoints: Ask AI, OG images, mixedbread search, the RSS
    // feed, and the OpenAPI reference page.
    expect(has("src/pages/api/ask.ts")).toBe(true);
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
        openapi: { enabled: true, renderer: "scalar", spec: "missing.json" },
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
      { root: "docs", type: "filesystem" },
      { owner: "acme", prefix: "changelog", repo: "sdk", type: "github-releases" },
    ],
  },
};\n`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    // The releases API returns no releases: the changelog index must still be
    // ejected so its route (and any nav tab pointing at it) does not 404.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({
        json: () => Promise.resolve([]),
        ok: true,
        status: 200,
      } as unknown as Response)) as unknown as typeof fetch;
    try {
      await eject(root);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(existsSync(join(root, "src/pages/changelog.astro"))).toBe(true);
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

describe("blumeSourceGlob", () => {
  const makeRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "blume-source-"));
    ejectDirs.push(root);
    return root;
  };

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
