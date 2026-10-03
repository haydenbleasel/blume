import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  contentAssetsEndpointTemplate,
  featuresTemplate,
} from "../src/astro/templates.ts";
import { eject } from "../src/registry/eject.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** A fresh project dir holding `files` (paths relative to it). */
const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-eject-output-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), "utf-8");

// `@import "pkg"` / `@plugin "pkg"` in a stylesheet: a package Tailwind
// resolves by name (relative and absolute paths name no package).
const CSS_PACKAGE_IMPORT = /@(?:import|plugin)\s+"(?<name>[^"./][^"]*)"/gu;

const cssPackages = (css: string): string[] =>
  [...css.matchAll(CSS_PACKAGE_IMPORT)].map(
    (match) => match.groups?.name ?? ""
  );

describe("eject dependencies", () => {
  it("declares the packages the ejected stylesheets import by name", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    const { dependencies } = await eject(root);

    // Under a strict linker (pnpm) only the project's own dependencies
    // resolve, so Tailwind's CSS resolution fails on any name left out.
    const imported = [
      ...cssPackages(read(root, "src/generated/app.css")),
      ...cssPackages(read(root, "src/generated/examples.css")),
    ];
    expect(imported).toEqual(
      expect.arrayContaining(["tailwindcss", "@tailwindcss/typography"])
    );
    expect(imported.filter((name) => !dependencies.includes(name))).toEqual([]);

    // Without EPUB export the dependency is left out, so `features.ts` must
    // not name the package even in a type: `astro check` would fail on it.
    expect(dependencies).not.toContain("epub-gen-memory");
    expect(read(root, "src/generated/features.ts")).not.toContain(
      "epub-gen-memory"
    );
    expect(dependencies).not.toContain("@ai-sdk/openai");
  });

  it("declares the SDK an openai() narration provider generates with", async () => {
    // The ejected app's `astro build` still generates the clips, and under a
    // strict linker Blume only loads the SDK when the project lists it.
    const root = await project({
      "blume.config.ts": `export default {
  narration: {
    provider: {
      kind: "openai",
      options: { baseUrl: "http://localhost:8880/v1", model: "kokoro" },
      requiredSecrets: ["OPENAI_API_KEY"],
      runtimeDeps: ["@ai-sdk/openai-compatible"],
    },
  },
};
`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const { dependencies } = await eject(root);
    expect(dependencies).toContain("@ai-sdk/openai");
    expect(dependencies).not.toContain("@ai-sdk/openai-compatible");
  });
});

describe("featuresTemplate EPUB loader", () => {
  it("names the EPUB bundle only when export.epub is on", () => {
    expect(featuresTemplate({ epub: false, mermaid: false })).toContain(
      "export const loadEpub: (() => Promise<unknown>) | null = null;"
    );
    expect(featuresTemplate({ epub: true, mermaid: false })).toContain(
      'export const loadEpub:\n  | (() => Promise<typeof import("epub-gen-memory/bundle")>)\n  | null = () => import("epub-gen-memory/bundle");'
    );
  });
});

describe("eject content assets", () => {
  it("serves colocated images the ejected raw Markdown points at", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "docs/diagram.png": "png-bytes",
      "docs/index.md":
        "---\ntitle: Home\n---\n# Home\n\n![Diagram](./diagram.png)\n",
    });

    const { files } = await eject(root);

    // The agent-facing Markdown references the endpoint URL...
    expect(read(root, "src/generated/raw-markdown.json")).toContain(
      "/blume-assets/content/docs/diagram.png"
    );
    // ...which the ejected app now serves: the endpoint plus the map behind
    // the `blume:content-assets` alias the ejected config already declares.
    const endpoint = join(root, "src/pages/blume-assets/[...asset].ts");
    const map = join(root, "src/generated/content-assets.json");
    expect(files).toEqual(expect.arrayContaining([endpoint, map]));
    expect(read(root, "astro.config.mjs")).toContain(
      '"blume:content-assets": fileURLToPath(new URL("./src/generated/content-assets.json", import.meta.url))'
    );
    // Paths are project-relative, like everything else eject writes, so the
    // app builds from any checkout.
    const assets: Record<string, string> = JSON.parse(
      readFileSync(map, "utf-8")
    );
    expect(assets).toEqual({ "docs/diagram.png": "docs/diagram.png" });
    expect(read(root, "src/generated/content-assets.json")).not.toContain(root);
    // Remote-source images live in the app's own public/ after eject, so the
    // endpoint serves no staged directory.
    expect(readFileSync(endpoint, "utf-8")).toBe(
      contentAssetsEndpointTemplate(null)
    );
  });
});

interface EndpointModule {
  GET: (context: { params: { asset?: string } }) => Promise<Response>;
  getStaticPaths: () => Promise<{ params: { asset: string } }[]>;
}

/** Load the generated endpoint with `assets` standing in for its data module. */
const loadEndpoint = async (
  root: string,
  assets: Record<string, string>
): Promise<EndpointModule> => {
  const source = contentAssetsEndpointTemplate(null).replace(
    'import assets from "blume:content-assets";',
    `const assets = ${JSON.stringify(assets)};`
  );
  const file = join(root, "endpoint.ts");
  await writeFile(file, source);
  return import(file);
};

describe("contentAssetsEndpointTemplate without a staged directory", () => {
  it("serves only the mapped content images", async () => {
    const root = await project({ "docs/diagram.png": "png-bytes" });
    const endpoint = await loadEndpoint(root, {
      "docs/diagram.png": join(root, "docs/diagram.png"),
    });

    expect(await endpoint.getStaticPaths()).toEqual([
      { params: { asset: "content/docs/diagram.png" } },
    ]);
    const hit = await endpoint.GET({
      params: { asset: "content/docs/diagram.png" },
    });
    expect(hit.status).toBe(200);
    expect(hit.headers.get("Content-Type")).toBe("image/png");
    expect(await hit.text()).toBe("png-bytes");
    // Nothing outside the map resolves: with no staged directory there is no
    // second family of files to fall back to.
    const misses = await Promise.all(
      [
        { asset: "endpoint.ts" },
        { asset: "docs/diagram.png" },
        { asset: "" },
        {},
      ].map((params) => endpoint.GET({ params }))
    );
    expect(misses.map((miss) => miss.status)).toEqual([404, 404, 404, 404]);
  });
});

describe("eject OG cards", () => {
  it("renders the changelog index's card when the index is ejected", async () => {
    const root = await project({
      "blume.config.ts":
        'export default { deployment: { site: "https://example.com" } };\n',
      "docs/changelog/v1.md":
        "---\ntitle: v1\ntype: changelog\ndate: 2024-02-01\n---\n# v1\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    // The ejected changelog page sets og:image to /og/changelog.png, so the
    // endpoint must emit that card, as the generated runtime does.
    expect(existsSync(join(root, "src/pages/changelog.astro"))).toBe(true);
    expect(read(root, "src/pages/og/[...slug].png.ts")).toContain(
      'add(\n    "changelog",'
    );
  });

  it("adds no changelog card without a changelog", async () => {
    const root = await project({
      "blume.config.ts":
        'export default { deployment: { site: "https://example.com" } };\n',
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    expect(existsSync(join(root, "src/pages/changelog.astro"))).toBe(false);
    expect(read(root, "src/pages/og/[...slug].png.ts")).not.toContain(
      '"changelog"'
    );
  });

  it("keeps the default script fallbacks so non-Latin cards render", async () => {
    const root = await project({
      "blume.config.ts":
        'export default { deployment: { site: "https://example.com" } };\n',
      "docs/index.md": "---\ntitle: はじめに\n---\n# はじめに\n",
    });

    await eject(root);

    const endpoint = read(root, "src/pages/og/[...slug].png.ts");
    expect(endpoint).toContain(
      'const fallbacks: OgGoogleFont[] = [{"name":"Noto Sans","weight":[400,600]}'
    );
    expect(endpoint).toContain('{"name":"Noto Sans JP","weight":[400,600]}');
    expect(endpoint).toContain(
      'const families: OgFontFamilies | undefined = {"body":"Geist","title":"Geist"}'
    );
  });

  it("leaves the fallbacks out when seo.og.fonts takes over", async () => {
    const root = await project({
      "blume.config.ts":
        'export default { deployment: { site: "https://example.com" }, seo: { og: { fonts: ["Inter"] } } };\n',
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    const endpoint = read(root, "src/pages/og/[...slug].png.ts");
    expect(endpoint).toContain("const fallbacks: OgGoogleFont[] = [];");
    expect(endpoint).toContain(
      "const families: OgFontFamilies | undefined = undefined;"
    );
  });
});
