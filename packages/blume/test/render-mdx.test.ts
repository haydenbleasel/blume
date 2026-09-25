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

describe("operationMdx descriptions", () => {
  it("keeps only the label of a spec link that isn't a web address", () => {
    const page = operationMdx(spec, {
      ...operation,
      description:
        "See [the guide](https://x.dev/g), [a trap](javascript:alert(1)), <javascript:alert(2)>, and [`code` {x}](data:text/html,hi). Code `[k](javascript:no)` stays.",
    });
    expect(page.body).toContain(
      String.raw`See [the guide](https://x.dev/g), a trap, javascript\:alert(2), and code \{x\}.`
    );
    expect(page.body).not.toContain("data:text/html");
    // Code outside a link stays verbatim, even when it reads like one.
    expect(page.body).toContain("Code `[k](javascript:no)` stays.");
  });
});
