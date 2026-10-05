import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { specIssues } from "../src/openapi/checks.ts";
import { extractOperations, operationObject } from "../src/openapi/model.ts";
import type { ApiDocument, ApiSpecData } from "../src/openapi/model.ts";
import { parseSpec } from "../src/openapi/parse.ts";

/**
 * OpenAPI 3.2 documents: read as written (3.2 is backward compatible with
 * 3.1), with the QUERY method rendered like any other, and the 3.2 features
 * Blume doesn't render yet reported instead of dropped without a sign.
 */

const SPEC_3_2 = `openapi: 3.2.0
$self: https://example.com/openapi.yaml
info:
  title: Search
  version: "1"
tags:
  - name: Search
    summary: Find things
    kind: nav
paths:
  /search:
    query:
      operationId: searchItems
      summary: Search items
      tags: [Search]
      requestBody:
        content:
          application/json:
            schema: { type: object }
      responses:
        "200":
          summary: The matches
`;

const withSpec = async <Result>(
  text: string,
  run: (dir: string) => Promise<Result>
): Promise<Result> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-openapi-3-2-"));
  try {
    await writeFile(join(dir, "openapi.yaml"), text);
    return await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

describe("OpenAPI 3.2", () => {
  it("reads a 3.2 document as written and renders its QUERY operation", async () => {
    await withSpec(SPEC_3_2, async (dir) => {
      const { document, warnings } = await parseSpec("openapi.yaml", dir);
      expect(warnings).toStrictEqual([]);
      expect(document.openapi).toBe("3.2.0");
      const { operations } = extractOperations(document, "/api");
      expect(
        operations.map(({ key, method, path, route }) => ({
          key,
          method,
          path,
          route,
        }))
      ).toStrictEqual([
        {
          key: "search-items",
          method: "query",
          path: "/search",
          route: "/api/search/search-items",
        },
      ]);
      const [ref] = operations;
      if (!ref) {
        throw new Error("expected the QUERY operation");
      }
      const spec: ApiSpecData = {
        codeSamples: [],
        description: "",
        document,
        expandSchemas: false,
        kind: "openapi",
        label: "API",
        operations: { [ref.key]: ref },
        playground: { enabled: false, proxy: false },
        route: "/api",
        slug: "api",
        tags: [],
        title: "Search",
        version: "1",
      };
      expect(operationObject(spec, ref)?.summary).toBe("Search items");
      expect(specIssues(document)).toStrictEqual([]);
    });
  });

  it("reports additionalOperations, which aren't rendered yet", () => {
    const document: ApiDocument = {
      info: { title: "API", version: "1" },
      openapi: "3.2.0",
      paths: {
        "/items": {
          additionalOperations: { COPY: {}, LINK: {} },
          get: {},
        },
      },
      webhooks: { moved: { additionalOperations: { MOVE: {} } } },
    };
    expect(specIssues(document)).toStrictEqual([
      {
        code: "BLUME_OPENAPI_UNSUPPORTED",
        message:
          'Path "/items" declares `additionalOperations` (COPY, LINK), which OpenAPI 3.2 added and Blume doesn\'t render yet, so those operations are missing from the reference.',
        suggestion:
          "Document those operations on a page of their own until Blume renders `additionalOperations`.",
      },
      {
        code: "BLUME_OPENAPI_UNSUPPORTED",
        message:
          'Webhook "moved" declares `additionalOperations` (MOVE), which OpenAPI 3.2 added and Blume doesn\'t render yet, so those operations are missing from the reference.',
        suggestion:
          "Document those operations on a page of their own until Blume renders `additionalOperations`.",
      },
    ]);
  });

  it("reports an in: querystring parameter, which isn't rendered yet", () => {
    const document: ApiDocument = {
      components: {
        parameters: {
          Filter: {
            content: { "application/json": {} },
            in: "querystring",
            name: "filter",
          },
        },
      },
      info: { title: "API", version: "1" },
      openapi: "3.2.0",
      paths: {
        "/search": {
          get: { parameters: [{ $ref: "#/components/parameters/Filter" }] },
          post: {},
        },
      },
    };
    expect(specIssues(document)).toStrictEqual([
      {
        code: "BLUME_OPENAPI_UNSUPPORTED",
        message:
          "GET /search declares an `in: querystring` parameter, which OpenAPI 3.2 added and Blume doesn't render yet, so the page has no row or Try it input for it and the code samples leave the query string out.",
        suggestion:
          "Describe the query string in the operation's `description` until Blume renders `querystring` parameters.",
      },
    ]);
  });

  it("ignores an empty or malformed additionalOperations", () => {
    const document: ApiDocument = {
      info: { title: "API", version: "1" },
      openapi: "3.2.0",
      paths: {
        "/a": { additionalOperations: {} },
        // SAFETY: a parsed YAML spec can hold a scalar where the type expects
        // a map; the check must step over it.
        "/b": { additionalOperations: "COPY" as never },
      },
    };
    expect(specIssues(document)).toStrictEqual([]);
  });
});
