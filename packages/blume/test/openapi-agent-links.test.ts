import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { downlevelComponents } from "../src/ai/component-markdown.ts";
import { buildLlmsFiles } from "../src/ai/llms.ts";
import { buildRawMarkdown } from "../src/ai/markdown.ts";
import { openapiComponentSerializers } from "../src/ai/openapi-components.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { ApiSpecData } from "../src/openapi/model.ts";

/**
 * The links the agent surfaces write for an API reference: operation links a
 * serializer creates are made after the page's own links were rebased, so
 * they take `deployment.base` themselves; and llms.txt link text survives
 * page titles with brackets in them.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const SPEC = {
  info: { title: "Pets", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        responses: { "200": { description: "ok" } },
        summary: "List pets",
        tags: ["pets"],
      },
    },
  },
  servers: [{ url: "https://api.example.com" }],
};

/** A project with one OpenAPI reference, served under `deployment.base`. */
const scanFixture = async (base: string) => {
  const root = await mkdtemp(join(tmpdir(), "blume-openapi-agent-links-"));
  dirs.push(root);
  await writeFile(
    join(root, "blume.config.ts"),
    `export default {
  deployment: { base: ${JSON.stringify(base)} },
  reference: [{ kind: "openapi", options: { spec: "./openapi.json" }, requiredSecrets: [], runtimeDeps: [] }],
};
`
  );
  await Bun.write(join(root, "docs/index.md"), "# Home\n");
  await Bun.write(
    join(root, "docs/beta.md"),
    "---\ntitle: '[Beta] Webhooks'\n---\n\nBeta.\n"
  );
  await writeFile(join(root, "openapi.json"), JSON.stringify(SPEC));
  return await scanProject(root);
};

describe("operation links on the agent surfaces", () => {
  it("carry deployment.base in the Markdown mirror and llms-full.txt", async () => {
    const project = await scanFixture("/sub");
    const raw = await buildRawMarkdown(project);
    const overview = Object.entries(raw).find(([, entry]) =>
      (entry.md ?? "").includes("`GET /pets`")
    );
    expect(overview?.[1].md).toContain("- [`GET /pets`](/sub/reference/pets/");
    const { full, index } = await buildLlmsFiles(project);
    expect(full).toContain("- [`GET /pets`](/sub/reference/pets/");
    expect(full).not.toContain("](/reference/pets/");
    // A title's brackets are escaped, so the link still parses.
    expect(index).toContain(String.raw`- [\[Beta\] Webhooks](/sub/beta)`);
  }, 30_000);

  it("leave a root-served site's links as routed", () => {
    const spec: ApiSpecData = {
      codeSamples: [],
      description: "",
      // SAFETY: the tag serializer never reads the document.
      document: {} as ApiSpecData["document"],
      expandSchemas: false,
      kind: "openapi",
      label: "API",
      operations: {
        "list-pets": {
          deprecated: false,
          description: "",
          key: "list-pets",
          method: "get",
          path: "/pets",
          route: "/api/pets/list-pets",
          summary: "",
          tag: "pets",
          tagSlug: "pets",
        },
      },
      playground: { enabled: false, proxy: false },
      route: "/api",
      slug: "api",
      tags: [{ description: "", name: "pets", slug: "pets" }],
      title: "Pets",
      version: "1",
    };
    const source = '<ApiTagOperations source="api" tag="pets" />\n';
    const data = { api: spec };
    expect(downlevelComponents(source, openapiComponentSerializers(data))).toBe(
      "- [`GET /pets`](/api/pets/list-pets)\n"
    );
    expect(
      downlevelComponents(source, openapiComponentSerializers(data, "/docs/"))
    ).toBe("- [`GET /pets`](/docs/api/pets/list-pets)\n");
  });
});
