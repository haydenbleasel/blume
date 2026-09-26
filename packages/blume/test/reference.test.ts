import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import { runtimeDependencies } from "../src/astro/templates.ts";
import { checkRequiredSecrets } from "../src/cli/required-secrets.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  blumeReferences,
  resolveReferences,
} from "../src/openapi/references.ts";
import { buildReferenceFiles } from "../src/openapi/scalar.ts";
import { asyncapi, graphql, openapi, scalar } from "../src/reference/index.ts";
import {
  referenceAdapterSchema,
  referenceConfigSchema,
  removedReferenceKeysHint,
} from "../src/reference/schema.ts";

describe("reference adapter factories", () => {
  it("return serializable descriptors that survive a JSON round trip", () => {
    const adapters = [
      openapi({ spec: "./openapi.yaml" }),
      asyncapi({ spec: "./asyncapi.yaml" }),
      graphql({
        endpoint: "https://api.test/graphql",
        spec: "./schema.graphql",
      }),
      scalar({ spec: "./legacy.yaml", theme: "moon" }),
    ];
    // JSON on purpose, not structuredClone: the descriptor is written to the
    // generated data snapshot and read back, so JSON's semantics are the contract.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    expect(JSON.parse(JSON.stringify(adapters))).toEqual(adapters);
    expect(adapters.map((adapter) => adapter.kind)).toEqual([
      "openapi",
      "asyncapi",
      "graphql",
      "scalar",
    ]);
  });

  it("keep the options verbatim and declare no secrets", () => {
    const adapter = openapi({
      codeSamples: ["curl"],
      expandSchemas: true,
      playground: { proxy: true },
      route: "/api",
      spec: "./openapi.yaml",
    });
    expect(adapter.options).toEqual({
      codeSamples: ["curl"],
      expandSchemas: true,
      playground: { proxy: true },
      route: "/api",
      spec: "./openapi.yaml",
    });
    expect(adapter.requiredSecrets).toEqual([]);
    expect(graphql({ spec: "s.graphql" }).requiredSecrets).toEqual([]);
  });

  it("declare the runtime dependency only on the Scalar embed", () => {
    // Blume's own renderer parses at generate time and needs nothing; the
    // Scalar embed imports `@scalar/astro` from the generated page.
    expect(openapi({ spec: "o.json" }).runtimeDeps).toEqual([]);
    expect(asyncapi({ spec: "a.yaml" }).runtimeDeps).toEqual([]);
    expect(graphql({ spec: "s.graphql" }).runtimeDeps).toEqual([]);
    expect(scalar({ spec: "o.json" }).runtimeDeps).toEqual(["@scalar/astro"]);
  });

  it("forward every scalar() option, theme included, onto the resolved reference", () => {
    const config = blumeConfigSchema.parse({
      reference: [
        scalar({
          hideTestRequestButton: true,
          spec: "https://x.dev/openapi.json",
          theme: "purple",
        }),
      ],
    });
    const [ref] = resolveReferences(config);
    expect(ref?.kind).toBe("scalar");
    // `route` and `sources` are Blume's, so they never reach the embed.
    expect(ref?.scalar).toEqual({
      hideTestRequestButton: true,
      theme: "purple",
    });
    expect(resolveReferences(config)[0]?.scalar).toEqual(ref?.scalar);
  });
});

describe("referenceAdapterSchema", () => {
  it("fills each kind's defaults and re-derives the metadata lists", () => {
    const parsed = blumeConfigSchema.parse({
      reference: [
        // Hand-edited metadata is validated for shape, then replaced by what
        // the resolved options imply, so JSON and factory descriptors agree.
        { ...openapi({ spec: "o.json" }), runtimeDeps: ["left-pad"] },
        asyncapi({ spec: "a.yaml" }),
        graphql({ spec: "s.graphql" }),
      ],
    }).reference;
    expect(parsed.map((adapter) => adapter.runtimeDeps)).toEqual([[], [], []]);
    expect(parsed[0]).toMatchObject({
      kind: "openapi",
      options: {
        codeSamples: ["curl", "js", "python"],
        expandSchemas: false,
        playground: { enabled: true, proxy: false },
        route: "/reference",
      },
    });
    expect(parsed[1]).toMatchObject({
      kind: "asyncapi",
      options: { codeSamples: [], route: "/events" },
    });
    expect(parsed[2]).toMatchObject({
      kind: "graphql",
      options: { codeSamples: ["curl", "js", "python"], route: "/graphql" },
    });
  });

  it("accepts codeSamples: false to generate no samples", () => {
    const parsed = blumeConfigSchema.parse({
      reference: [
        openapi({ codeSamples: false, spec: "o.json" }),
        asyncapi({ codeSamples: false, spec: "a.yaml" }),
        graphql({ codeSamples: false, spec: "s.graphql" }),
      ],
    }).reference;
    expect(
      parsed.map((adapter) =>
        adapter.kind === "scalar" ? null : adapter.options.codeSamples
      )
    ).toEqual([false, false, false]);
    const blume = blumeReferences(
      blumeConfigSchema.parse({
        reference: [openapi({ codeSamples: false, spec: "o.json" })],
      })
    );
    expect(blume[0]?.display.codeSamples).toBe(false);
  });

  it("re-derives the Scalar dependency from the resolved kind", () => {
    const [adapter] = blumeConfigSchema.parse({
      reference: [
        {
          ...scalar({ spec: "o.json" }),
          runtimeDeps: [],
        },
      ],
    }).reference;
    expect(adapter?.runtimeDeps).toEqual(["@scalar/astro"]);
    expect(
      runtimeDependencies({
        config: blumeConfigSchema.parse({
          reference: [scalar({ spec: "o.json" }), scalar({ spec: "a.yaml" })],
        }),
        needsReact: false,
      }).filter((dep) => dep === "@scalar/astro")
    ).toHaveLength(1);
  });

  it("resolves the spec shorthand into sources and drops the spec key", () => {
    const [shorthand, both] = blumeConfigSchema.parse({
      reference: [
        openapi({ spec: "./one.json" }),
        graphql({
          sources: [{ label: "Two", spec: "./two.graphql" }],
          spec: "./one.graphql",
        }),
      ],
    }).reference;
    expect(shorthand?.options).not.toHaveProperty("spec");
    expect(shorthand?.options.sources).toEqual([
      {
        includeInLlms: true,
        includeInSearch: true,
        noindex: false,
        overlays: [],
        seoDescriptionSuffix: true,
        spec: "./one.json",
      },
    ]);
    // The shorthand comes first, then the explicit sources.
    expect(both?.options.sources.map((source) => source.spec)).toEqual([
      "./one.graphql",
      "./two.graphql",
    ]);
  });

  it("rejects a source-less adapter, naming its factory", () => {
    for (const [adapter, factory] of [
      [openapi({}), "openapi"],
      [asyncapi({ sources: [] }), "asyncapi"],
      [graphql({ endpoint: "https://api.test/graphql" }), "graphql"],
    ] as const) {
      const result = referenceConfigSchema.safeParse([adapter]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(`${factory}()`);
      expect(result.error?.issues[0]?.path).toEqual([0, "options", "sources"]);
    }
  });

  it("names the scalar() adapter when a config still passes renderer", () => {
    // `renderer` left the factories' types with the standalone adapter; the
    // schema refuses it at runtime with the replacement spelled out.
    for (const factory of [openapi, asyncapi]) {
      const result = referenceConfigSchema.safeParse([
        {
          ...factory({ spec: "o.json" }),
          options: { renderer: { kind: "scalar" }, spec: "o.json" },
        },
      ]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([0, "options"]);
      expect(result.error?.issues[0]?.message).toContain(
        "scalar({ spec, theme })"
      );
    }
    // An unrelated typo beside `renderer` isn't dropped from the diagnostic.
    const both = referenceConfigSchema.safeParse([
      {
        ...openapi({ spec: "o.json" }),
        options: { colour: 1, renderer: "scalar", spec: "o.json" },
      },
    ]);
    expect(both.error?.issues[0]?.message).toContain(
      '`openapi({ spec, renderer: "scalar", theme })`'
    );
    expect(both.error?.issues[0]?.message).toEndWith(
      'Unrecognized key: "colour"'
    );
    // Any other unknown key keeps Zod's own wording; GraphQL never had the
    // option, so it gets the plain message too.
    for (const bad of [
      { ...openapi({ spec: "o.json" }), options: { bogus: 1, spec: "o.json" } },
      {
        ...graphql({ spec: "s.graphql" }),
        options: { expandSchemas: true, spec: "s.graphql" },
      },
      {
        ...graphql({ spec: "s.graphql" }),
        options: { renderer: { kind: "scalar" }, spec: "s.graphql" },
      },
    ]) {
      const result = referenceConfigSchema.safeParse([bad]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).not.toContain("scalar({");
    }
  });

  it("folds a scalar() spec into sources and keeps the passthrough beside them", () => {
    const [adapter] = referenceConfigSchema.parse([
      scalar({
        hideTestRequestButton: true,
        sources: [{ label: "Two", spec: "./two.json" }],
        spec: "./one.json",
      }),
    ]);
    const options = adapter?.kind === "scalar" ? adapter.options : null;
    expect(options).toEqual({
      hideTestRequestButton: true,
      route: "/reference",
      sources: [
        { noindex: false, overlays: [], spec: "./one.json" },
        { label: "Two", noindex: false, overlays: [], spec: "./two.json" },
      ],
    });
    const result = referenceConfigSchema.safeParse([
      { ...scalar({ spec: "o.json" }), options: { theme: "purple" } },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("scalar()");
  });

  it("rejects a scalar() option JSON can't carry", () => {
    // A function is exactly what the option type forbids, so the descriptor
    // is hand-built to reach the runtime check.
    const descriptor = {
      ...scalar({ spec: "o.json" }),
      options: { onLoaded: () => 1, spec: "o.json" },
    };
    const result = referenceConfigSchema.safeParse([descriptor]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([0, "options", "onLoaded"]);
  });

  it("rejects an unknown kind", () => {
    expect(
      referenceAdapterSchema.safeParse({
        kind: "grpc",
        options: { spec: "s.proto" },
        requiredSecrets: [],
        runtimeDeps: [],
      }).success
    ).toBe(false);
    expect(
      referenceAdapterSchema.safeParse({
        ...scalar({ spec: "o.json" }),
        kind: "redoc",
      }).success
    ).toBe(false);
  });

  it("defaults to an empty list and rejects a non-list with the hint", () => {
    expect(blumeConfigSchema.parse({}).reference).toEqual([]);
    const result = referenceConfigSchema.safeParse({ openapi: {} });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      'imported from "blume/reference"'
    );
  });

  it("rejects the 1.x blocks and words the hint for the keys present", () => {
    // The keys are gone from the schema; the root object's error hook turns
    // the rejection into the migration hint.
    const rejected = blumeConfigSchema.safeParse({
      openapi: { enabled: true, spec: "o.json" },
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues[0]?.message).toContain(
      "replaced by `reference`"
    );
    const hint =
      removedReferenceKeysHint(["graphql", "title", "openapi"]) ?? "";
    expect(hint).toContain("`graphql`, `openapi`");
    expect(hint).toContain("reference: [graphql({ … }), openapi({ … })]");
    expect(hint).toContain('"blume/reference"');
    // A plain unknown key beside them keeps zod's own wording in the hint…
    expect(hint).toEndWith('Unrecognized key: "title"');
    // …and alone gets zod's message untouched.
    expect(removedReferenceKeysHint(["colour"])).toBeUndefined();
  });
});

describe("route dedupe across adapters", () => {
  it("keeps the first Blume-rendered source on a shared route and records the loss", () => {
    const config = blumeConfigSchema.parse({
      reference: [
        openapi({ route: "/api", spec: "o.json" }),
        asyncapi({ route: "/api", spec: "a.yaml" }),
        graphql({ spec: "s.graphql" }),
      ],
    });
    const refs = blumeReferences(config);
    expect(refs.map((ref) => [ref.kind, ref.route])).toEqual([
      ["openapi", "/api"],
      ["graphql", "/graphql"],
    ]);
    expect(refs[0]?.collisions).toEqual([
      "Two API reference sources resolve to /api; keeping the first.",
    ]);
  });

  it("keeps the first scalar() source on a shared route and warns", async () => {
    const config = blumeConfigSchema.parse({
      reference: [
        scalar({
          route: "/api",
          spec: "https://x.dev/o.json",
        }),
        scalar({
          route: "/api",
          spec: "https://x.dev/a.yaml",
        }),
      ],
    });
    const { files, warnings } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    expect(files.map((file) => file.pagePath)).toEqual(["api.astro"]);
    expect(warnings).toEqual([
      "Two API reference sources resolve to /api; keeping the first.",
    ]);
  });
});

describe("required secrets", () => {
  afterEach(() => {
    delete process.env.REFERENCE_TEST_SECRET;
  });

  it("warns for an adapter's unset secret and stays quiet once it is set", () => {
    // The built-in adapters declare none, so the resolved descriptor is given
    // one by hand to reach the path.
    const parsed = blumeConfigSchema.parse({
      reference: [openapi({ spec: "o.json" })],
    });
    const config = {
      ...parsed,
      reference: parsed.reference.map((adapter) => ({
        ...adapter,
        requiredSecrets: ["REFERENCE_TEST_SECRET"],
      })),
    };
    delete process.env.REFERENCE_TEST_SECRET;
    const [diagnostic] = checkRequiredSecrets(config);
    expect(diagnostic?.message).toBe(
      "API reference (openapi) is enabled but REFERENCE_TEST_SECRET is not set."
    );
    process.env.REFERENCE_TEST_SECRET = "set";
    expect(checkRequiredSecrets(config)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Generated pages: one project per kind, each fed an inline descriptor (a
// tmp-dir config can't import `blume/reference`, and the descriptor is plain
// data either way).
// ---------------------------------------------------------------------------

const projectDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    projectDirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const OPENAPI_SPEC = JSON.stringify({
  info: { title: "Pets", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        responses: { "200": {} },
        tags: ["pets"],
      },
    },
  },
});

const ASYNCAPI_SPEC = JSON.stringify({
  asyncapi: "3.0.0",
  channels: {
    ping: {
      address: "ping",
      messages: { ping: { payload: { type: "string" } } },
    },
  },
  info: { title: "Events", version: "1" },
  operations: {
    sendPing: { action: "send", channel: { $ref: "#/channels/ping" } },
  },
});

const projectWith = async (
  reference: string,
  files: Record<string, string>
) => {
  const root = await mkdtemp(join(tmpdir(), "blume-reference-"));
  projectDirs.push(root);
  await writeFile(
    join(root, "blume.config.ts"),
    `export default { reference: [${reference}] };\n`
  );
  await Promise.all([
    Bun.write(join(root, "docs/index.md"), "# Home\n"),
    ...Object.entries(files).map(([name, content]) =>
      writeFile(join(root, name), content)
    ),
  ]);
  return scanProject(root);
};

describe("generated pages per kind", () => {
  it("stages one page per OpenAPI operation under the adapter's route", async () => {
    const project = await projectWith(
      JSON.stringify(openapi({ route: "/api", spec: "./openapi.json" })),
      { "openapi.json": OPENAPI_SPEC }
    );
    const routes = project.graph.pages.map((page) => page.route);
    expect(routes).toContain("/api");
    expect(routes).toContain("/api/pets/list-pets");
  }, 30_000);

  it("stages one page per AsyncAPI operation under the adapter's route", async () => {
    const project = await projectWith(
      JSON.stringify(asyncapi({ spec: "./asyncapi.json" })),
      { "asyncapi.json": ASYNCAPI_SPEC }
    );
    const routes = project.graph.pages.map((page) => page.route);
    expect(routes).toContain("/events");
    expect(routes.some((route) => route.startsWith("/events/"))).toBe(true);
  }, 30_000);

  it("stages root-field and type pages for a GraphQL schema", async () => {
    const project = await projectWith(
      JSON.stringify(
        graphql({
          endpoint: "https://api.test/graphql",
          spec: "./schema.graphql",
        })
      ),
      {
        "schema.graphql":
          "type Pet { name: String }\ntype Query { pets: [Pet] }",
      }
    );
    const routes = project.graph.pages.map((page) => page.route);
    expect(routes).toContain("/graphql");
    expect(routes).toContain("/graphql/queries/pets");
    expect(routes).toContain("/graphql/objects/pet");
  }, 30_000);

  it("writes a Scalar page and declares @scalar/astro for a scalar() adapter", async () => {
    const project = await projectWith(
      JSON.stringify(
        scalar({
          spec: "https://x.dev/openapi.json",
          theme: "purple",
        })
      ),
      {}
    );
    await generateRuntime(project);
    const out = project.context.outDir;
    const page = join(out, "src/pages/reference.astro");
    expect(existsSync(page)).toBe(true);
    expect(await readFile(page, "utf-8")).toContain('"theme": "purple"');
    expect(await readFile(join(out, "package.json"), "utf-8")).toContain(
      '"@scalar/astro"'
    );
    // Scalar pages don't flow through the content pipeline.
    expect(project.graph.pages.map((entry) => entry.route)).not.toContain(
      "/reference"
    );
  }, 30_000);
});
