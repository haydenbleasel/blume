import { describe, expect, it } from "bun:test";

import type { ApiOperationRef, ApiSpecData } from "../src/openapi/model.ts";
import { operationMdx } from "../src/openapi/render-mdx.ts";

const spec: ApiSpecData = {
  codeSamples: [],
  description: "",
  document: { info: { title: "Petstore", version: "1.0.0" }, openapi: "3.1.0" },
  expandSchemas: false,
  kind: "openapi",
  label: "Petstore",
  operations: {},
  playground: { enabled: true, proxy: false },
  route: "/api",
  slug: "api",
  tags: [],
  title: "Petstore",
  version: "1.0.0",
};

const operation: ApiOperationRef = {
  deprecated: true,
  description: "",
  key: "list-pets",
  method: "get",
  path: "/pets",
  route: "/api/pets/list-pets",
  summary: "List pets",
  tag: "Pets",
  tagSlug: "pets",
};

describe("operationMdx", () => {
  it("marks a deprecated operation in the frontmatter", () => {
    const page = operationMdx(spec, operation);
    expect(page.data.deprecated).toBe(true);
  });

  it("omits the deprecated flag for a live operation", () => {
    const page = operationMdx(spec, { ...operation, deprecated: false });
    expect(page.data).not.toHaveProperty("deprecated");
  });
});
