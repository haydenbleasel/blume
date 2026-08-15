import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { serverFeatures } from "../src/core/server-features.ts";
import { resolveReferences } from "../src/openapi/references.ts";
import { openApiSource } from "../src/openapi/source.ts";

/** Shorthand: the resolved `openapi.playground` for a given input. */
const playgroundOf = (playground?: unknown) =>
  blumeConfigSchema.parse({
    openapi: { enabled: true, playground, spec: "spec.json" },
  }).openapi.playground;

describe("openapi.playground config schema", () => {
  it("defaults to an enabled, proxy-less playground", () => {
    expect(blumeConfigSchema.parse({}).openapi.playground).toStrictEqual({
      enabled: true,
      proxy: false,
    });
  });

  it("normalizes the boolean shorthands to the object shape", () => {
    expect(playgroundOf(true)).toStrictEqual({ enabled: true, proxy: false });
    expect(playgroundOf(false)).toStrictEqual({ enabled: false, proxy: false });
  });

  it("fills object-form defaults", () => {
    expect(playgroundOf({})).toStrictEqual({ enabled: true, proxy: false });
    expect(playgroundOf({ enabled: false })).toStrictEqual({
      enabled: false,
      proxy: false,
    });
  });

  it("keeps proxy: true and proxy URLs verbatim", () => {
    expect(playgroundOf({ proxy: true })).toStrictEqual({
      enabled: true,
      proxy: true,
    });
    expect(playgroundOf({ proxy: "https://x" })).toStrictEqual({
      enabled: true,
      proxy: "https://x",
    });
  });

  it("strictly rejects unknown playground subkeys", () => {
    expect(
      blumeConfigSchema.safeParse({
        openapi: {
          enabled: true,
          playground: { enalbed: true },
          spec: "spec.json",
        },
      }).success
    ).toBeFalsy();
  });
});

describe("resolveReferences playground display", () => {
  it("carries the resolved playground onto OpenAPI references", () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        playground: { proxy: "https://proxy.example" },
        spec: "spec.json",
      },
    });
    expect(resolveReferences(config)[0]?.display.playground).toStrictEqual({
      enabled: true,
      proxy: "https://proxy.example",
    });
  });

  it("carries an enabled playground onto AsyncAPI references by default", () => {
    const config = blumeConfigSchema.parse({
      asyncapi: { enabled: true, spec: "async.yaml" },
    });
    expect(resolveReferences(config)[0]?.renderer).toBe("blume");
    expect(resolveReferences(config)[0]?.display.playground).toStrictEqual({
      enabled: true,
      proxy: false,
    });
  });

  it("honors playground: false on the asyncapi block", () => {
    const config = blumeConfigSchema.parse({
      asyncapi: { enabled: true, playground: false, spec: "async.yaml" },
    });
    expect(resolveReferences(config)[0]?.display.playground).toStrictEqual({
      enabled: false,
      proxy: false,
    });
  });
});

/** A loadable minimal spec plus one reference per proxy scenario. */
const referenceWith = (
  slug: string,
  basePath: string,
  playground: { enabled: boolean; proxy: string | boolean }
) => ({
  basePath,
  display: { codeSamples: [], expandSchemas: false, playground },
  includeInLlms: true,
  includeInSearch: true,
  kind: "openapi" as const,
  label: "API",
  noindex: false,
  renderer: "blume" as const,
  route: `/${slug}`,
  slug,
  spec: "spec.json",
});

describe("ApiSpecData.playground resolution", () => {
  it("resolves the proxy: basePath'd built-in route, verbatim URL, or false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-playground-"));
    try {
      await writeFile(
        join(dir, "spec.json"),
        JSON.stringify({
          info: { title: "API", version: "1" },
          openapi: "3.1.0",
          paths: { "/ping": { get: { responses: { "200": {} } } } },
        })
      );
      const source = openApiSource(
        [
          referenceWith("builtin", "", { enabled: true, proxy: true }),
          referenceWith("based", "/docs", { enabled: true, proxy: true }),
          referenceWith("external", "", {
            enabled: true,
            proxy: "https://proxy.example",
          }),
          referenceWith("direct", "", { enabled: true, proxy: false }),
          // An empty proxy string is meaningless as a URL, so it disables
          // proxying rather than emitting a fetch to "".
          referenceWith("blank", "", { enabled: true, proxy: "" }),
          referenceWith("hidden", "", { enabled: false, proxy: false }),
        ],
        {
          cacheDir: join(dir, ".blume/cache/openapi"),
          mode: "build",
          projectRoot: dir,
        }
      );
      await source.load();
      const data = source.openApiData();
      expect(data.builtin?.playground).toStrictEqual({
        enabled: true,
        proxy: "/_api-proxy",
      });
      expect(data.based?.playground).toStrictEqual({
        enabled: true,
        proxy: "/docs/_api-proxy",
      });
      expect(data.external?.playground).toStrictEqual({
        enabled: true,
        proxy: "https://proxy.example",
      });
      expect(data.direct?.playground).toStrictEqual({
        enabled: true,
        proxy: false,
      });
      expect(data.blank?.playground).toStrictEqual({
        enabled: true,
        proxy: false,
      });
      expect(data.hidden?.playground).toStrictEqual({
        enabled: false,
        proxy: false,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

const parse = (openapi: Record<string, unknown>) =>
  blumeConfigSchema.parse({ openapi });

describe("serverFeatures playground proxy", () => {
  it("requires server output only for the built-in proxy (proxy: true)", () => {
    expect(
      serverFeatures(
        parse({ enabled: true, playground: { proxy: true }, spec: "s.json" })
      )
    ).toStrictEqual(["API playground proxy"]);
  });

  it("stays static for an external proxy URL or no proxy", () => {
    expect(
      serverFeatures(
        parse({
          enabled: true,
          playground: { proxy: "https://proxy.example" },
          spec: "s.json",
        })
      )
    ).toStrictEqual([]);
    expect(
      serverFeatures(parse({ enabled: true, spec: "s.json" }))
    ).toStrictEqual([]);
  });

  it("stays static when the playground or the reference is off", () => {
    expect(
      serverFeatures(
        parse({
          enabled: true,
          playground: { enabled: false, proxy: true },
          spec: "s.json",
        })
      )
    ).toStrictEqual([]);
    expect(
      serverFeatures(
        parse({
          enabled: false,
          playground: { proxy: true },
          spec: "s.json",
        })
      )
    ).toStrictEqual([]);
  });

  it("stays static for the Scalar renderer (no native playground)", () => {
    expect(
      serverFeatures(
        parse({
          enabled: true,
          playground: { proxy: true },
          renderer: "scalar",
          spec: "s.json",
        })
      )
    ).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Generate-level: the `/_api-proxy` endpoint is written and injected only when
// the built-in proxy is opted in (mirrors how the MCP endpoint is tested).
// ---------------------------------------------------------------------------

const projectDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    projectDirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const generateWith = async (playground: string) => {
  const root = await mkdtemp(join(tmpdir(), "blume-playground-gen-"));
  projectDirs.push(root);
  await writeFile(
    join(root, "blume.config.ts"),
    `export default {
  openapi: { enabled: true, playground: ${playground}, spec: "./openapi.json" },
};
`
  );
  await Bun.write(join(root, "docs/index.md"), "# Home\n");
  await writeFile(
    join(root, "openapi.json"),
    JSON.stringify({
      info: { title: "API", version: "1" },
      openapi: "3.0.0",
      paths: { "/ping": { get: { responses: { "200": {} } } } },
    })
  );
  const project = await scanProject(root);
  await generateRuntime(project);
  return project.context.outDir;
};

describe("generateRuntime playground proxy endpoint", () => {
  it("writes and injects /_api-proxy when proxy is true", async () => {
    const out = await generateWith("{ proxy: true }");
    expect(existsSync(join(out, "src/blume-openapi/api-proxy.ts"))).toBe(true);
    // Injected (rather than served from `pages/`) because `_`-prefixed page
    // files are private to Astro; the pattern rides the integration's pages.
    const astroConfig = await readFile(join(out, "astro.config.mjs"), "utf-8");
    expect(astroConfig).toContain('"pattern":"/_api-proxy"');
  }, 30_000);

  it("skips the endpoint for an external proxy URL", async () => {
    const out = await generateWith('{ proxy: "https://proxy.example" }');
    expect(existsSync(join(out, "src/blume-openapi/api-proxy.ts"))).toBe(false);
    const astroConfig = await readFile(join(out, "astro.config.mjs"), "utf-8");
    expect(astroConfig).not.toContain("/_api-proxy");
  }, 30_000);
});
