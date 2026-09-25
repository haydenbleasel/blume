import { describe, expect, it } from "bun:test";

import { mdxToMdast } from "satteri";

import { MDX_FEATURES } from "../src/markdown/features.ts";
import { blumeMdxProcessor } from "../src/markdown/index.ts";
import type { ApiOperationRef, ApiSpecData } from "../src/openapi/model.ts";
import { operationMdx, overviewMdx } from "../src/openapi/render-mdx.ts";

const operation: ApiOperationRef = {
  deprecated: false,
  description: "",
  key: "list-pets",
  method: "get",
  path: "/pets",
  route: "/api/pets/list-pets",
  summary: "List pets",
  tag: "Pets",
  tagSlug: "pets",
};

const spec: ApiSpecData = {
  codeSamples: [],
  description: "",
  document: { info: { title: "Petstore", version: "1.0.0" }, openapi: "3.1.0" },
  expandSchemas: false,
  kind: "openapi",
  label: "Petstore",
  operations: { "list-pets": operation },
  playground: { enabled: true, proxy: false },
  route: "/api",
  slug: "api",
  tags: [],
  title: "Petstore",
  version: "1.0.0",
};

/** The body of an operation page whose spec description is `description`. */
const operationBody = (description: string): string =>
  operationMdx(spec, { ...operation, description }).body;

/** The top-level node types and JSX names of a staged MDX body. */
const topLevel = (body: string): string[] => {
  // SAFETY: every mdast root Satteri returns has a `children` list of nodes
  // with a `type`; a JSX element also carries its `name`.
  const tree = mdxToMdast(body, { features: MDX_FEATURES }) as {
    children: { name?: string; type: string }[];
  };
  return tree.children.map((node) => node.name ?? node.type);
};

describe("spec prose with text-directive lookalikes", () => {
  it("renders `:word` in a description as written", async () => {
    const body = operationBody("Requires the pets:read scope at 10:30.");
    const renderer = await blumeMdxProcessor({}).createRenderer({});
    const { code } = await renderer.render(body);
    expect(code).toContain("Requires the pets:read scope at 10:30.");
  });
});

describe("spec descriptions that leave a code fence open", () => {
  it("closes the fence before the <Operation> component", () => {
    const body = operationBody('Returns:\n\n```json\n{"id": 1}');
    expect(body).toBe(
      'Returns:\n\n```json\n{"id": 1}\n```\n\n<Operation source="api" id="list-pets" />'
    );
    expect(topLevel(body)).toStrictEqual(["paragraph", "code", "Operation"]);
  });

  it("closes a fence that is only its opener", () => {
    expect(topLevel(operationBody("```sh"))).toStrictEqual([
      "code",
      "Operation",
    ]);
  });

  it("closes with the opener's own run, so a shorter run inside stays code", () => {
    const body = operationBody("~~~~md\n~~~\nstill code");
    expect(body).toStartWith("~~~~md\n~~~\nstill code\n~~~~\n\n<Operation");
    expect(topLevel(body)).toStrictEqual(["code", "Operation"]);
  });

  it("finds a fence after a line that reads as an HTML block", () => {
    // `<` is escaped in the emitted MDX, so the `<div>` line can't hide the
    // fence the way a CommonMark HTML block would.
    const body = operationBody("<div>\n```js\nlet x");
    expect(topLevel(body)).toStrictEqual(["paragraph", "code", "Operation"]);
  });

  it("leaves a closed fence, indented code, and a quoted fence alone", () => {
    for (const description of [
      "```js\nlet x\n```",
      "Text\n\n    indented",
      "> ```js\n> let x",
    ]) {
      expect(operationBody(description)).toBe(
        `${description}\n\n<Operation source="api" id="list-pets" />`
      );
    }
  });

  it("closes the fence before the <ApiOverview> and tag sections", () => {
    const page = overviewMdx({
      ...spec,
      description: "Overview\n\n```bash\ncurl https://x.dev",
      tags: [{ description: "Pets.\n\n```\nopen", name: "Pets", slug: "pets" }],
    });
    expect(topLevel(page.body)).toStrictEqual([
      "paragraph",
      "code",
      "ApiOverview",
      "heading",
      "paragraph",
      "code",
      "ApiTagOperations",
    ]);
  });
});
