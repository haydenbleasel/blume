import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import type { JsonValue } from "../src/core/adapter.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  applyOverlay,
  isJsonObject,
  overlayDocument,
  OverlayError,
} from "../src/openapi/overlay.ts";
import { parseSpec, readOverlaidSpec } from "../src/openapi/parse.ts";
import { resolveReferences } from "../src/openapi/references.ts";
import { buildReferenceFiles } from "../src/openapi/scalar.ts";
import { openapi, scalar } from "../src/reference/index.ts";

/**
 * OpenAPI Overlays (Overlay Specification 1.0 and 1.1): validation, the
 * update/copy/remove semantics, and the two places a spec reads them — the
 * Blume renderer's parse and the Scalar embed's inlined document.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** A fresh document, so every test mutates its own. */
const spec = (): JsonValue => ({
  components: { schemas: { Foo: { type: "object" } } },
  info: { title: "Pets", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/admin": { get: { operationId: "admin", "x-internal": true } },
    "/pets": {
      get: { operationId: "list", tags: ["pets"] },
      post: { operationId: "create", "x-internal": true },
    },
  },
  servers: [{ url: "https://a.example" }, { url: "https://b.example" }],
});

/** An overlay document with `actions`. */
const overlay = (actions: JsonValue[], version = "1.1.0"): JsonValue => ({
  actions,
  info: { title: "Test", version: "1" },
  overlay: version,
});

/** `document` after `actions`, or the error they raise. */
const applied = (actions: JsonValue[], document = spec()): JsonValue => {
  applyOverlay(document, overlayDocument(overlay(actions), "o.yaml"), "o.yaml");
  return document;
};

/** The message `actions` fail with. */
const failure = (actions: JsonValue[]): string => {
  try {
    applied(actions);
  } catch (error) {
    // SAFETY: the overlay throws OverlayError instances.
    return (error as Error).message;
  }
  return "";
};

describe(overlayDocument, () => {
  it("accepts 1.0 and 1.1 overlays", () => {
    expect(
      overlayDocument(overlay([{ target: "$" }], "1.0.0"), "a").overlay
    ).toBe("1.0.0");
    expect(
      overlayDocument(overlay([{ remove: true, target: "$.x" }]), "a")
        .actions[0]?.remove
    ).toBe(true);
  });

  it("names the file and the field that's wrong", () => {
    expect(() =>
      overlayDocument(overlay([{ target: "$" }], "2.0.0"), "o.yaml")
    ).toThrow(
      "o.yaml is not an overlay document: `overlay` must be an Overlay Specification version, 1.0.x or 1.1.x."
    );
    expect(() => overlayDocument(overlay([]), "o.yaml")).toThrow(
      "o.yaml is not an overlay document: `actions`"
    );
    expect(() => overlayDocument(undefined, "o.yaml")).toThrow(
      "o.yaml is not an overlay document: "
    );
    expect(() => overlayDocument(overlay([]), "o.yaml")).toThrow(OverlayError);
  });
});

describe(applyOverlay, () => {
  it("merges an update: objects recursively, arrays appended, primitives replaced", () => {
    const result = applied([
      {
        target: "$.info",
        update: { description: "All the pets.", title: "Pet Store" },
      },
      { target: "$.servers", update: [{ url: "https://c.example" }] },
      { target: "$.info.version", update: "2.0.0" },
      { target: "$.paths['/pets'].get", update: { tags: ["animals"] } },
    ]);
    expect(result).toMatchObject({
      info: {
        description: "All the pets.",
        title: "Pet Store",
        version: "2.0.0",
      },
      paths: { "/pets": { get: { tags: ["pets", "animals"] } } },
      servers: [
        { url: "https://a.example" },
        { url: "https://b.example" },
        { url: "https://c.example" },
      ],
    });
  });

  it("removes every target, including by filter and from arrays", () => {
    const result = applied([
      { remove: true, target: "$.paths.*[?@['x-internal'] == true]" },
      { remove: true, target: "$.servers[*]" },
      { target: "$.paths['/admin']", update: {} },
    ]);
    expect(result).toMatchObject({
      paths: { "/admin": {}, "/pets": { get: { operationId: "list" } } },
      servers: [],
    });
    expect(JSON.stringify(result)).not.toContain("create");
  });

  it("copies one node into the targets (1.1)", () => {
    const result = applied([
      { target: "$.components.schemas", update: { Bar: {} } },
      { copy: "$.components.schemas.Foo", target: "$.components.schemas.Bar" },
    ]);
    expect(result).toMatchObject({
      components: { schemas: { Bar: { type: "object" } } },
    });
  });

  it("leaves the document alone when nothing matches or nothing is asked", () => {
    expect(
      applied([{ target: "$.nope", update: { a: 1 } }, { target: "$.info" }])
    ).toStrictEqual(spec());
  });

  it("lets remove win over update, and update over copy", () => {
    const result = applied([
      { remove: true, target: "$.info.title", update: "Kept?" },
      {
        copy: "$.openapi",
        target: "$.info.version",
        update: "3.0.0",
      },
    ]);
    expect(result).toMatchObject({ info: { version: "3.0.0" } });
    expect(JSON.stringify(result)).not.toContain('"title"');
  });

  it("says which action failed, and why", () => {
    expect(failure([{ target: "$.servers", update: { url: "x" } }])).toBe(
      "o.yaml action 1 ($.servers): can't merge an object into an array at $.servers"
    );
    expect(
      failure([{ target: "$.info", update: { title: { text: "x" } } }])
    ).toBe(
      "o.yaml action 1 ($.info): can't merge an object into a primitive value at $.info.title"
    );
    expect(failure([{ target: "$.*", update: {} }])).toBe(
      "o.yaml action 1 ($.*): its target selects a mix of array, object, primitive values, and an update needs all one kind"
    );
    expect(failure([{ copy: "$.paths.*", target: "$.info" }])).toBe(
      'o.yaml action 1 ($.info): its copy expression "$.paths.*" selects 2 nodes, and copy needs exactly one'
    );
    expect(failure([{ remove: true, target: "$" }])).toBe(
      "o.yaml action 1 ($): can't remove the document itself"
    );
    expect(failure([{ target: "$.paths[?(", update: {} }])).toStartWith(
      "o.yaml action 1 ($.paths[?(): Expected"
    );
  });

  it("recognizes a parsed mapping as a document", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});

/** A project directory holding `files`. */
const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-overlay-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(([path, content]) =>
      writeFile(join(root, path), content, "utf-8")
    )
  );
  return root;
};

const SWAGGER = `swagger: "2.0"
info:
  title: Pets
  version: "1"
paths:
  /pets:
    get:
      operationId: list
      responses:
        "200":
          description: OK
  /internal:
    get:
      operationId: secret
      responses:
        "200":
          description: OK
`;

const OVERLAY = `overlay: 1.1.0
info:
  title: Public docs
  version: "1"
actions:
  - target: $.paths['/internal']
    remove: true
  - target: $.info
    update:
      description: The public Pets API.
`;

describe("specs with overlays", () => {
  it("applies overlays to the spec as written, before the upgrade", async () => {
    const root = await project({
      "overlay.yaml": OVERLAY,
      "spec.yaml": SWAGGER,
    });
    const { document } = await parseSpec("spec.yaml", root, {
      overlays: ["overlay.yaml"],
    });
    expect(document.openapi).toStartWith("3.1");
    expect(document.info?.description).toBe("The public Pets API.");
    expect(Object.keys(document.paths ?? {})).toStrictEqual(["/pets"]);

    const { text } = await readOverlaidSpec("spec.yaml", root, {
      overlays: ["overlay.yaml"],
    });
    expect(JSON.parse(text)).toMatchObject({
      info: { description: "The public Pets API." },
      swagger: "2.0",
    });
  });

  it("fails the load with the overlay's error", async () => {
    const root = await project({
      "bad.yaml":
        "overlay: 1.1.0\ninfo:\n  title: x\n  version: '1'\nactions: []\n",
      "spec.yaml": SWAGGER,
    });
    await expect(
      parseSpec("spec.yaml", root, { overlays: ["bad.yaml"] })
    ).rejects.toThrow("bad.yaml is not an overlay document");
  });

  it("leaves a spec that isn't a mapping for the parser to reject", async () => {
    const root = await project({
      "list.yaml": "- 1\n- 2\n",
      "overlay.yaml": OVERLAY,
    });
    await expect(
      parseSpec("list.yaml", root, { overlays: ["overlay.yaml"] })
    ).rejects.toThrow("is not a valid OpenAPI document");
  });

  it("embeds the overlaid spec in Scalar, and skips a page whose overlay fails", async () => {
    const root = await project({
      "bad.yaml": "not: an overlay\n",
      "overlay.yaml": OVERLAY,
      "spec.yaml": SWAGGER,
    });
    const config = blumeConfigSchema.parse({
      reference: [
        scalar({
          sources: [
            { overlays: ["overlay.yaml"], route: "/public", spec: "spec.yaml" },
            { overlays: ["bad.yaml"], route: "/broken", spec: "spec.yaml" },
          ],
        }),
      ],
    });
    const { files, warnings } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root,
    });
    expect(files.map((file) => file.pagePath)).toStrictEqual(["public.astro"]);
    expect(files[0]?.content).toContain("The public Pets API.");
    expect(files[0]?.content).not.toContain("secret");
    expect(warnings).toStrictEqual([
      'API reference /broken was skipped: its overlays couldn\'t be applied to "spec.yaml" (bad.yaml is not an overlay document: `actions` Invalid input: expected array, received undefined.).',
    ]);
  });
});

describe("overlays in the reference config", () => {
  it("folds overlays beside spec into its source, for openapi() and scalar()", () => {
    const config = blumeConfigSchema.parse({
      reference: [
        openapi({ overlays: ["a.yaml"], route: "/api", spec: "spec.yaml" }),
        scalar({ overlays: ["b.yaml"], route: "/embed", spec: "spec.yaml" }),
        openapi({ route: "/plain", spec: "spec.yaml" }),
      ],
    });
    expect(
      resolveReferences(config).map((reference) => reference.overlays)
    ).toStrictEqual([["a.yaml"], ["b.yaml"], []]);
  });

  it("rejects overlays beside sources instead of spec", () => {
    for (const adapter of [
      openapi({ overlays: ["a.yaml"], sources: [{ spec: "s.yaml" }] }),
      scalar({ overlays: ["a.yaml"], sources: [{ spec: "s.yaml" }] }),
    ]) {
      const result = blumeConfigSchema.safeParse({ reference: [adapter] });
      expect(JSON.stringify(result.error?.issues)).toContain(
        "`overlays` belongs to the `spec` shorthand"
      );
    }
  });
});
