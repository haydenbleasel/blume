import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";
import { mdxToJs } from "satteri";
import type { MdastPluginDefinition } from "satteri";

import {
  apiPageOrigins,
  apiPageProxyWarnings,
  buildRuntimeData,
} from "../src/astro/generate.ts";
import {
  endpointBody,
  endpointParameters,
  endpointSecurity,
  endpointTarget,
  fieldSchema,
  parseApiEndpoint,
  readEndpointSpec,
} from "../src/components/content/api-page.ts";
import type {
  EndpointField,
  EndpointSpec,
} from "../src/components/content/api-page.ts";
import { operationModel } from "../src/components/openapi/operation-model.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { pageMetaSchema } from "../src/core/schema.ts";
import { API_RAIL_KEY, apiRailPlugin } from "../src/markdown/api-rail.ts";
import { needsPlaygroundProxy } from "../src/openapi/references.ts";

/**
 * Hand-written endpoint pages (`api` frontmatter): the endpoint the page's
 * `<ParamField>`s describe, collected by the rail plugin and turned into the
 * OpenAPI-shaped pieces the playground and samples are built from.
 */

describe(parseApiEndpoint, () => {
  it("reads a method and a path or URL", () => {
    expect(parseApiEndpoint(" post /v1/users ")).toEqual({
      method: "POST",
      target: "/v1/users",
    });
    expect(parseApiEndpoint("GET https://api.acme.com/v1/{id}")).toEqual({
      method: "GET",
      target: "https://api.acme.com/v1/{id}",
    });
    expect(parseApiEndpoint("FETCH /x")).toBeNull();
    expect(parseApiEndpoint("/x")).toBeNull();
  });

  it("is what the frontmatter schema accepts", () => {
    expect(pageMetaSchema.safeParse({ api: "POST /v1/users" }).success).toBe(
      true
    );
    expect(pageMetaSchema.safeParse({ api: "users" }).success).toBe(false);
    expect(
      pageMetaSchema.safeParse({ authMethod: "key", playground: "simple" })
        .success
    ).toBe(true);
    expect(pageMetaSchema.safeParse({ playground: "full" }).success).toBe(
      false
    );
  });
});

describe(endpointTarget, () => {
  it("splits a URL into its server, and joins a path to the site's", () => {
    expect(endpointTarget("https://api.acme.com/v1/users?x=1")).toEqual({
      path: "/v1/users?x=1",
      servers: [{ url: "https://api.acme.com" }],
    });
    expect(endpointTarget("https://api.acme.com")).toEqual({
      path: "/",
      servers: [{ url: "https://api.acme.com" }],
    });
    expect(endpointTarget("/users", "https://api.acme.com/v1/")).toEqual({
      path: "/users",
      servers: [{ url: "https://api.acme.com/v1" }],
    });
    expect(endpointTarget("users")).toEqual({ path: "/users", servers: [] });
  });
});

describe("fields as schema", () => {
  const endpointFields: EndpointField[] = [
    { location: "path", name: "id", type: "string" },
    { location: "query", name: "limit", required: true, type: "integer" },
    { deprecated: true, location: "header", name: "x-old" },
    {
      default: "member",
      location: "body",
      name: "role",
      required: true,
      type: "enum<string>",
    },
    { location: "body", name: "tags", type: "string[]" },
    {
      fields: [
        { location: "body", name: "city", placeholder: "Oslo", type: "string" },
      ],
      location: "body",
      name: "address",
      type: "object",
    },
  ];

  it("makes the path, query, and header fields parameters", () => {
    expect(endpointParameters(endpointFields)).toEqual([
      {
        deprecated: false,
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string" },
      },
      {
        deprecated: false,
        in: "query",
        name: "limit",
        required: true,
        schema: { type: "integer" },
      },
      {
        deprecated: true,
        in: "header",
        name: "x-old",
        required: false,
        schema: { deprecated: true, type: "string" },
      },
    ]);
  });

  it("makes the body fields a JSON object, nested and typed", () => {
    expect(endpointBody(endpointFields)).toEqual({
      content: {
        "application/json": {
          // `tags` is optional with no default or placeholder, so the
          // example leaves it out; `address` is in for its child's placeholder.
          example: { address: { city: "Oslo" }, role: "member" },
          schema: {
            properties: {
              address: {
                properties: { city: { example: "Oslo", type: "string" } },
                type: "object",
              },
              role: { default: "member", type: "string" },
              tags: { items: { type: "string" }, type: "array" },
            },
            required: ["role"],
            type: "object",
          },
        },
      },
    });
    expect(endpointBody([])).toBeUndefined();
    expect(fieldSchema({ location: "body", name: "n" })).toEqual({
      type: "string",
    });
  });

  it("starts Try it with the required fields and the ones with a value", () => {
    const model = operationModel({
      method: "POST",
      parameters: [],
      path: "/users",
      requestBody: endpointBody([
        { location: "body", name: "email", required: true, type: "string" },
        { location: "body", name: "note", type: "string" },
        { location: "body", name: "count", type: "integer" },
        { location: "body", name: "active", type: "boolean" },
        { default: 10, location: "body", name: "limit", type: "integer" },
        { location: "body", name: "hint", placeholder: "hi", type: "string" },
        {
          fields: [{ location: "body", name: "tag", type: "string" }],
          location: "body",
          name: "meta",
          required: true,
          type: "object",
        },
        // Its child is required only once the reader sends the object.
        {
          fields: [
            { location: "body", name: "city", required: true, type: "string" },
          ],
          location: "body",
          name: "address",
          type: "object",
        },
      ]),
      schemas: {},
      security: { alternatives: [], optional: false },
      servers: [],
    });
    // An optional field with neither a default nor a placeholder used to go
    // out as the sampler's "string", 0, or true.
    expect(JSON.parse(model.body?.example ?? "")).toEqual({
      email: "string",
      hint: "hi",
      limit: 10,
      meta: {},
    });
  });
});

describe(endpointSecurity, () => {
  it("takes the page's method over the site's, and none by default", () => {
    expect(endpointSecurity()).toEqual({ alternatives: [], optional: false });
    expect(endpointSecurity("none", { method: "bearer" }).alternatives).toEqual(
      []
    );
    expect(
      endpointSecurity(undefined, { method: "bearer" }).alternatives[0]?.[0]
        ?.scheme
    ).toEqual({ scheme: "bearer", type: "http" });
    expect(endpointSecurity("basic").alternatives[0]?.[0]?.scheme).toEqual({
      scheme: "basic",
      type: "http",
    });
    expect(
      endpointSecurity("key", { method: "key", name: "X-Token" })
        .alternatives[0]?.[0]?.scheme
    ).toEqual({ in: "header", name: "X-Token", type: "apiKey" });
    expect(endpointSecurity("key").alternatives[0]?.[0]?.scheme?.name).toBe(
      "x-api-key"
    );
  });
});

// SAFETY: the plugin models the slice of Satteri's visitor protocol it uses,
// as Blume's pipeline bridges it (see `asMdastPlugin` there).
const asMdastPlugin = (plugin: { name: string }): MdastPluginDefinition =>
  plugin as MdastPluginDefinition;

/** Compile a page whose front matter the plugin reads, as Astro passes it. */
const compile = async (
  source: string,
  frontmatter: Record<string, boolean | string>
) => {
  // The render data Astro hands a compile; the plugin writes the rail flag
  // into this same front matter object.
  const { code } = await mdxToJs(source, {
    data: {
      astro: {
        frontmatter,
        headings: [],
        localImagePaths: new Set(),
        remoteImagePaths: new Set(),
      },
    },
    mdastPlugins: [asMdastPlugin(apiRailPlugin())],
  });
  return { code, frontmatter };
};

/** The endpoint spec a compiled page hands `<ApiPlayground>`. */
const specOf = (code: string, component = "ApiPlayground"): EndpointSpec => {
  const match = new RegExp(
    `_jsx\\(${component}, \\{\\s*spec: (".*?[^\\\\]")`,
    "su"
  ).exec(code);
  return readEndpointSpec(JSON.parse(match?.[1] ?? '"{}"'));
};

const FIELDS = [
  '<ParamField path="id" type="string" required>',
  "  The ID.",
  "</ParamField>",
  "",
  '<ParamField query="limit" type="integer" default={20} required={true} deprecated="true" />',
  "",
  '<ParamField body="address" type="object" placeholder={frontmatter.hint}>',
  '  <Expandable title="properties">',
  '    <ParamField body="city" type="string" default={{ a: 1 }} />',
  "  </Expandable>",
  "</ParamField>",
  "",
  '<ParamField name="ignored" />',
  "",
  "<ParamField query={someName} />",
].join("\n");

describe("the endpoint on the page", () => {
  it("collects the fields, nested ones included, into the header and the playground", async () => {
    const { code, frontmatter } = await compile(FIELDS, {
      api: "POST /v1/things/{id}",
      authMethod: "key",
      hint: "Somewhere",
      playground: "simple",
    });
    expect(code.indexOf("ApiEndpoint")).toBeLessThan(code.indexOf("ApiRail"));
    expect(specOf(code, "ApiEndpoint").target).toBe("/v1/things/{id}");
    expect(specOf(code)).toEqual({
      authMethod: "key",
      fields: [
        { location: "path", name: "id", required: true, type: "string" },
        {
          default: 20,
          deprecated: true,
          location: "query",
          name: "limit",
          required: true,
          type: "integer",
        },
        {
          fields: [
            {
              default: { a: 1 },
              location: "body",
              name: "city",
              type: "string",
            },
          ],
          location: "body",
          name: "address",
          placeholder: "Somewhere",
          type: "object",
        },
      ],
      method: "POST",
      playground: "simple",
      requestExample: false,
      target: "/v1/things/{id}",
    });
    expect(frontmatter[API_RAIL_KEY]).toBe(true);
  });

  it("puts the header after a front matter block, and notes the page's request example", async () => {
    const { code } = await compile(
      [
        "---",
        "title: T",
        "---",
        "",
        "Intro.",
        "",
        "<RequestExample>",
        "```bash cURL",
        "curl x",
        "```",
        "</RequestExample>",
      ].join("\n"),
      { api: "GET /x" }
    );
    expect(specOf(code).requestExample).toBe(true);
    expect(code.indexOf("ApiEndpoint")).toBeLessThan(code.indexOf("Intro."));
  });

  it("leaves the playground out with `playground: none`, and the rail too with no examples", async () => {
    const { code, frontmatter } = await compile("Text.", {
      api: "GET /x",
      playground: "none",
    });
    expect(code).toContain("ApiEndpoint");
    expect(code).not.toContain("ApiPlayground");
    expect(code).not.toContain("ApiRail");
    expect(frontmatter[API_RAIL_KEY]).toBeUndefined();
  });

  it("ignores an `api` that isn't an endpoint", async () => {
    const { code } = await compile("Text.", { api: "nope" });
    expect(code).not.toContain("ApiEndpoint");
  });
});

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** Scan a project with a config and two endpoint pages, one on a full URL. */
const scanWith = async (api: string) => {
  const root = await mkdtemp(join(tmpdir(), "blume-api-pages-"));
  dirs.push(root);
  const files = {
    "blume.config.ts": `export default { api: ${api} };\n`,
    "docs/a.mdx": "---\ntitle: A\napi: POST /users\n---\n\nA.\n",
    "docs/b.mdx":
      "---\ntitle: B\napi: GET https://other.acme.com/b\n---\n\nB.\n",
    "docs/index.md": "# Home\n",
  };
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, "utf-8");
    })
  );
  return scanProject(root, { mode: "build" });
};

describe("the site's api defaults", () => {
  it("reach the runtime with the built-in proxy resolved to its route", async () => {
    const project = await scanWith(
      '{ server: "https://api.acme.com/v1", auth: { method: "key", name: "X-Key" }, playground: { proxy: true } }'
    );
    expect(JSON.parse(buildRuntimeData(project)).config.api).toEqual({
      auth: { method: "key", name: "X-Key" },
      playground: { enabled: true, proxy: "/_api-proxy" },
      server: "https://api.acme.com/v1",
    });
    expect(needsPlaygroundProxy(project.config)).toBe(true);
    expect(apiPageOrigins(project).toSorted()).toEqual([
      "https://api.acme.com",
      "https://other.acme.com",
    ]);
    expect(apiPageProxyWarnings(project)).toEqual([]);
  });

  it("pass an external proxy through, and allow nothing without the built-in one", async () => {
    const project = await scanWith(
      '{ playground: { proxy: "https://proxy.acme.com" } }'
    );
    expect(JSON.parse(buildRuntimeData(project)).config.api).toEqual({
      playground: { enabled: true, proxy: "https://proxy.acme.com" },
    });
    expect(needsPlaygroundProxy(project.config)).toBe(false);
    expect(apiPageOrigins(project)).toEqual([]);
  });

  it("warn when the built-in proxy has no origin to allow", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-api-pages-"));
    dirs.push(root);
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "blume.config.ts"),
      'export default { api: { server: "/v1", playground: { proxy: true } } };\n',
      "utf-8"
    );
    await writeFile(join(root, "docs/index.md"), "# Home\n", "utf-8");
    const project = await scanProject(root, { mode: "build" });
    expect(apiPageProxyWarnings(project)).toHaveLength(1);
  });
});
