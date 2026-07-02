import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { eject } from "../src/registry/eject.ts";
import {
  findItem,
  itemsRoot,
  packageSrc,
  registry,
} from "../src/registry/registry.ts";
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
    // images (via deployment.site), an OpenAPI reference, and mixedbread search.
    await writeFiles(root, {
      "blume.config.ts": `export default {
        ai: { ask: { enabled: true } },
        deployment: { site: "https://example.com" },
        openapi: { enabled: true, renderer: "scalar", spec: "openapi.json" },
        search: { mixedbread: { storeId: "store-1" }, provider: "mixedbread" },
      };\n`,
      // A blog post so an RSS feed is produced (alongside the home page).
      "docs/blog/hello.md":
        "---\ntitle: Hello\ntype: blog\ndate: 2024-01-01\n---\n# Hello\n",
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

    const files = await eject(root);
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

    // Materialized assets copied across; the hidden runtime is removed.
    expect(has("public/blume-assets/img.png")).toBe(true);
    expect(has(".blume")).toBe(false);

    // The custom page is wired into the generated Astro config.
    const astroConfig = readFileSync(join(root, "astro.config.mjs"), "utf-8");
    expect(astroConfig).toContain("pages/custom.astro");

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

    // Every returned path was actually written.
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => existsSync(file))).toBe(true);
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

    const files = await eject(root);

    // The user's tuned config is untouched and not reported as ejected.
    expect(readFileSync(join(root, "tsconfig.json"), "utf-8")).toBe(tuned);
    expect(files.some((file) => file.endsWith("tsconfig.json"))).toBe(false);
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

  it("exposes a non-empty registry and an items root path", () => {
    expect(registry.length).toBeGreaterThan(0);
    expect(itemsRoot.endsWith("items")).toBe(true);
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
