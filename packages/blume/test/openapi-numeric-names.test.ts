import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { extractOperations } from "../src/openapi/model.ts";
import { parseSpec } from "../src/openapi/parse.ts";

/**
 * YAML reads an unquoted `operationId: 404` or `tags: [2024]` as a number.
 * The spec still names the operation and its tag; loading it must not crash
 * on a string method the number doesn't have.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const YAML = `openapi: 3.0.3
info: { title: Numbers, version: "1" }
tags:
  - name: 2024
    description: This year's endpoints.
  - name: { nested: true }
paths:
  /status:
    get:
      operationId: 404
      summary: 2024
      description: 7
      tags: [2024]
      responses: { "200": { description: ok } }
  /other:
    get:
      operationId: { not: text }
      tags: [{ not: text }]
      responses: { "200": { description: ok } }
`;

describe("numeric names in an OpenAPI spec", () => {
  it("reads a numeric operationId, tag, and prose as text", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-numeric-"));
    dirs.push(root);
    await writeFile(join(root, "openapi.yaml"), YAML);
    const { document } = await parseSpec("openapi.yaml", root);
    const { operations, tags } = extractOperations(document, "/api");
    expect(
      operations.map(
        ({ key, operationId, route, summary, description, tag }) => ({
          description,
          key,
          operationId,
          route,
          summary,
          tag,
        })
      )
    ).toStrictEqual([
      {
        description: "7",
        key: "404",
        operationId: "404",
        route: "/api/2024/404",
        summary: "2024",
        tag: "2024",
      },
      // Neither a string nor a number: treated as absent.
      {
        description: "",
        key: "get-other",
        operationId: undefined,
        route: "/api/operations/get-other",
        summary: "",
        tag: "Operations",
      },
    ]);
    // The declared numeric tag keeps its description; an object name is no tag.
    expect(tags).toStrictEqual([
      { description: "This year's endpoints.", name: "2024", slug: "2024" },
      { description: "", name: "Operations", slug: "operations" },
    ]);
  });
});
