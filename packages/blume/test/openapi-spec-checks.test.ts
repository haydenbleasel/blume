import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { specIssues } from "../src/openapi/checks.ts";
import type { ApiDocument } from "../src/openapi/model.ts";
import { parseSpec } from "../src/openapi/parse.ts";
import { openApiSource } from "../src/openapi/source.ts";

/** Any value a parsed YAML/JSON document can hold. */
type Fixture = string | number | boolean | null | Fixture[] | FixtureObject;

interface FixtureObject {
  [key: string]: Fixture;
}

/**
 * A spec as the checks see it: arbitrary parsed YAML/JSON, so fixtures carry
 * the malformed shapes (a null path item, a scalar `parameters`) the checks
 * must step over.
 */
const asDocument = (spec: FixtureObject): ApiDocument =>
  // SAFETY: the fixtures below are minimal parsed documents, deliberately
  // malformed in places; the checks guard every field they read.
  spec as ApiDocument;

const codes = (spec: FixtureObject): string[] =>
  specIssues(asDocument(spec)).map((issue) => issue.code);

describe("specIssues: path parameters", () => {
  it("flags a path placeholder with no path parameter", () => {
    const issues = specIssues(
      asDocument({
        paths: { "/pets/{petId}": { get: { responses: {} } } },
      })
    );
    expect(issues).toStrictEqual([
      {
        code: "BLUME_OPENAPI_PATH_PARAMETER_MISSING",
        message:
          'GET /pets/{petId} has {petId} in its path but declares no "petId" path parameter, so Try it and the code samples send "{petId}" as literal text.',
        suggestion:
          "Declare \"petId\" in the operation's or the path's `parameters`, with `in: path` and `required: true`.",
      },
    ]);
  });

  it("flags a path parameter the path never uses", () => {
    const issues = specIssues(
      asDocument({
        paths: {
          "/pets": {
            get: { parameters: [{ in: "path", name: "petId" }] },
          },
        },
      })
    );
    expect(issues.map((issue) => issue.code)).toStrictEqual([
      "BLUME_OPENAPI_PATH_PARAMETER_UNUSED",
    ]);
    expect(issues[0]?.message).toBe(
      'GET /pets declares a "petId" path parameter, but its path has no {petId}, so the value Try it asks for never reaches the URL.'
    );
  });

  it("accepts parameters declared on the path item, the operation, or by $ref", () => {
    expect(
      codes({
        components: {
          parameters: { OwnerId: { in: "path", name: "ownerId" } },
        },
        paths: {
          "/owners/{ownerId}/pets/{petId}": {
            get: {
              parameters: [
                { $ref: "#/components/parameters/OwnerId" },
                { in: "query", name: "limit" },
              ],
            },
            parameters: [{ in: "path", name: "petId" }],
          },
        },
      })
    ).toStrictEqual([]);
  });

  it("reports each placeholder once, per operation", () => {
    expect(
      codes({
        paths: {
          "/a/{id}/b/{id}": { get: {}, post: {} },
        },
      })
    ).toStrictEqual([
      "BLUME_OPENAPI_PATH_PARAMETER_MISSING",
      "BLUME_OPENAPI_PATH_PARAMETER_MISSING",
    ]);
  });

  it("treats an unresolved or non-path parameter as undeclared", () => {
    expect(
      codes({
        paths: {
          "/pets/{petId}": {
            get: {
              parameters: [
                { $ref: "#/components/parameters/Missing" },
                { $ref: "./shared.yaml#/petId" },
                { in: "path", name: 7 },
                null,
              ],
            },
          },
        },
      })
    ).toStrictEqual(["BLUME_OPENAPI_PATH_PARAMETER_MISSING"]);
  });

  it("steps over malformed path items and operations", () => {
    expect(
      codes({
        paths: {
          "/a/{id}": null,
          "/b/{id}": { $ref: "#/components/pathItems/b" },
          "/c/{id}": { get: "nope", parameters: "nope" },
          "/d/{id}": {
            get: { parameters: "nope" },
            parameters: [{ in: "path", name: "id" }],
          },
        },
      })
    ).toStrictEqual([]);
  });

  it("doesn't read a webhook's name as a path template", () => {
    expect(codes({ webhooks: { "{event}": { post: {} } } })).toStrictEqual([]);
  });
});

describe("specIssues: security schemes", () => {
  it("flags a root requirement naming an undefined scheme once", () => {
    const issues = specIssues(
      asDocument({
        paths: { "/pets": { get: { security: [{ apiKey: [] }] } } },
        security: [{ apiKey: [] }, {}],
      })
    );
    expect(issues).toStrictEqual([
      {
        code: "BLUME_OPENAPI_UNKNOWN_SECURITY_SCHEME",
        message:
          "The spec's root `security` requires the \"apiKey\" security scheme, which `components.securitySchemes` doesn't define, so the Authorization section can't describe it and requests send no credential for it.",
        suggestion:
          'Define "apiKey" in `components.securitySchemes`, or fix the name in `security`.',
      },
    ]);
  });

  it("names the operation that requires an undefined scheme", () => {
    const [issue] = specIssues(
      asDocument({
        components: { securitySchemes: { bearer: { type: "http" } } },
        paths: {
          "/pets": { get: { security: [{ bearer: [] }, { oauth: ["read"] }] } },
        },
        security: [{ bearer: [] }],
      })
    );
    expect(issue?.message).toStartWith(
      'GET /pets requires the "oauth" security scheme'
    );
  });

  it("names the first few operations and counts the rest", () => {
    const operation = { security: [{ oauth: [] }] };
    const [issue] = specIssues(
      asDocument({
        paths: {
          "/a": { get: operation, post: operation },
          "/b": { delete: operation },
        },
        webhooks: { gone: { post: operation }, newPet: { post: operation } },
      })
    );
    expect(issue?.message).toStartWith(
      'GET /a, POST /a, DELETE /b and 2 more require the "oauth" security scheme'
    );
  });

  it("names a webhook by its name", () => {
    const [issue] = specIssues(
      asDocument({
        webhooks: { newPet: { post: { security: [{ hmac: [] }] } } },
      })
    );
    expect(issue?.message).toStartWith(
      'Webhook "newPet" (POST) requires the "hmac" security scheme'
    );
  });

  it("ignores a malformed security list", () => {
    expect(
      codes({
        paths: { "/pets": { get: { security: "apiKey" } } },
        security: [null],
      })
    ).toStrictEqual([]);
  });
});

describe("specIssues: x-webhooks", () => {
  const hook = { newPet: { post: { summary: "New pet" } } };

  it("flags x-webhooks in a spec that wasn't upgraded from 3.0", () => {
    expect(
      specIssues(asDocument({ openapi: "3.1.0", "x-webhooks": hook }))
    ).toStrictEqual([
      {
        code: "BLUME_OPENAPI_X_WEBHOOKS",
        message:
          "The spec declares its webhooks under `x-webhooks`, the extension OpenAPI 3.0 tools read. Blume reads it only from a 3.0 spec, which it upgrades, so these webhooks are missing from the reference.",
        suggestion:
          "Rename `x-webhooks` to `webhooks`, the field OpenAPI 3.1 added for them.",
      },
    ]);
  });

  it("stays quiet when webhooks sits beside it", () => {
    expect(
      codes({ openapi: "3.1.0", webhooks: hook, "x-webhooks": hook })
    ).toStrictEqual([]);
  });

  it("stays quiet for a 3.0 spec, whose upgrade renames it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-openapi-checks-"));
    try {
      await writeFile(
        join(dir, "spec.json"),
        JSON.stringify({
          info: { title: "Pets", version: "1" },
          openapi: "3.0.3",
          paths: {},
          "x-webhooks": hook,
        })
      );
      const { document } = await parseSpec("spec.json", dir);
      expect(Object.keys(document.webhooks ?? {})).toStrictEqual(["newPet"]);
      expect(specIssues(document)).toStrictEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("openApiSource: spec checks", () => {
  it("reports each issue as a warning naming the spec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-openapi-checks-"));
    try {
      await writeFile(
        join(dir, "spec.json"),
        JSON.stringify({
          info: { title: "Pets", version: "1" },
          openapi: "3.1.0",
          paths: { "/pets/{petId}": { get: { responses: {} } } },
        })
      );
      const { diagnostics } = await openApiSource(
        [
          {
            basePath: "",
            display: {
              codeSamples: [],
              expandSchemas: false,
              playground: { enabled: true, proxy: false },
            },
            includeInLlms: true,
            includeInSearch: true,
            kind: "openapi",
            label: "API",
            noindex: false,
            route: "/api",
            seoDescriptionSuffix: true,
            slug: "api",
            spec: "spec.json",
          },
        ],
        { cacheDir: join(dir, "cache"), mode: "build", projectRoot: dir }
      ).load();
      expect(diagnostics).toStrictEqual([
        {
          code: "BLUME_OPENAPI_PATH_PARAMETER_MISSING",
          message:
            'In OpenAPI spec "spec.json": GET /pets/{petId} has {petId} in its path but declares no "petId" path parameter, so Try it and the code samples send "{petId}" as literal text.',
          severity: "warning",
          suggestion:
            "Declare \"petId\" in the operation's or the path's `parameters`, with `in: path` and `required: true`.",
        },
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
