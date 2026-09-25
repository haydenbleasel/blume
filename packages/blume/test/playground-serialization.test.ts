import { describe, expect, it } from "bun:test";

import { operationModel } from "../src/components/openapi/operation-model.ts";
import {
  defaultStyle,
  parseStyledValue,
  queryPairs,
  styledValue,
  templateValue,
} from "../src/components/openapi/param-style.ts";
import type { StyledValue } from "../src/components/openapi/param-style.ts";
import {
  bodyEncoding,
  buildRequest,
  defaultValues,
} from "../src/components/openapi/request.ts";
import type { PlaygroundModel } from "../src/components/openapi/request.ts";
import { sampleLanguages } from "../src/components/openapi/snippets.ts";
import type { RequestSample } from "../src/components/openapi/snippets.ts";

/**
 * How the playground puts a request on the wire: parameter `style`/`explode`
 * (`param-style.ts`), bodies serialized by media type, and the code samples
 * that render them — all through the one request builder, so the samples and
 * Send agree.
 */

type ModelArgs = Parameters<typeof operationModel>[0];

const buildModel = (overrides: Partial<ModelArgs> = {}): PlaygroundModel =>
  operationModel({
    method: "get",
    parameters: [],
    path: "/pets",
    schemas: {},
    security: { alternatives: [], optional: false },
    servers: [{ url: "https://api.test" }],
    ...overrides,
  });

/** The default request for a model: its examples, as the samples show it. */
const request = (model: PlaygroundModel): RequestSample =>
  buildRequest(model, defaultValues(model));

const sample = (id: string, built: RequestSample): string =>
  sampleLanguages([id])[0]?.build(built) ?? "";

const LIST: StyledValue = { items: ["a b", "c"], kind: "list" };
const OBJECT: StyledValue = {
  entries: [
    ["R", "100"],
    ["G", "2 0"],
  ],
  kind: "object",
};
const SCALAR: StyledValue = { kind: "scalar", text: "x y" };

/** A query parameter `id`, serialized and joined as a query string. */
const pairs = (value: StyledValue, style: string, explode: boolean): string =>
  queryPairs("id", value, style, explode).join("&");

/** A path parameter `id`, serialized with percent-encoding. */
const path = (value: StyledValue, style: string, explode: boolean): string =>
  templateValue("id", value, style, explode, encodeURIComponent);

describe("param-style", () => {
  it("lowers parsed JSON and parses only array- and object-typed text", () => {
    expect(styledValue([1, "a", { b: null }])).toStrictEqual({
      items: ["1", "a", '{"b":null}'],
      kind: "list",
    });
    expect(styledValue({ a: 1, b: "x" })).toStrictEqual({
      entries: [
        ["a", "1"],
        ["b", "x"],
      ],
      kind: "object",
    });
    expect(styledValue(true)).toStrictEqual({ kind: "scalar", text: "true" });
    expect(parseStyledValue('["a"]', "array")).toStrictEqual({
      items: ["a"],
      kind: "list",
    });
    expect(parseStyledValue('{"a":"b"}', "object").kind).toBe("object");
    // Text that isn't JSON, or isn't the declared shape, is one scalar.
    for (const [text, type] of [
      ["dog,cat", "array"],
      ['{"a":1}', "array"],
      ["[1]", "object"],
      ['["a"]', "string"],
    ]) {
      expect(parseStyledValue(text ?? "", type ?? "")).toStrictEqual({
        kind: "scalar",
        text: text ?? "",
      });
    }
    expect(defaultStyle("query")).toBe("form");
    expect(defaultStyle("cookie")).toBe("form");
    expect(defaultStyle("path")).toBe("simple");
    expect(defaultStyle("header")).toBe("simple");
  });

  it("serializes query styles, exploded and not", () => {
    expect(pairs(SCALAR, "form", true)).toBe("id=x%20y");
    expect(pairs(LIST, "form", true)).toBe("id=a%20b&id=c");
    expect(pairs(LIST, "form", false)).toBe("id=a%20b,c");
    expect(pairs(OBJECT, "form", true)).toBe("R=100&G=2%200");
    expect(pairs(OBJECT, "form", false)).toBe("id=R,100,G,2%200");
    expect(pairs(LIST, "spaceDelimited", false)).toBe("id=a%20b%20c");
    expect(pairs(LIST, "pipeDelimited", false)).toBe("id=a%20b|c");
    expect(pairs(OBJECT, "pipeDelimited", false)).toBe("id=R|100|G|2%200");
    // Exploded, the delimited styles repeat the name like form.
    expect(pairs(LIST, "pipeDelimited", true)).toBe("id=a%20b&id=c");
    expect(pairs(OBJECT, "deepObject", true)).toBe("id[R]=100&id[G]=2%200");
  });

  it("serializes path and header styles", () => {
    expect(path(SCALAR, "simple", false)).toBe("x%20y");
    expect(path(LIST, "simple", false)).toBe("a%20b,c");
    expect(path(LIST, "simple", true)).toBe("a%20b,c");
    expect(path(OBJECT, "simple", false)).toBe("R,100,G,2%200");
    expect(path(OBJECT, "simple", true)).toBe("R=100,G=2%200");
    expect(path(SCALAR, "label", false)).toBe(".x%20y");
    expect(path(LIST, "label", false)).toBe(".a%20b,c");
    expect(path(LIST, "label", true)).toBe(".a%20b.c");
    expect(path(OBJECT, "label", true)).toBe(".R=100.G=2%200");
    expect(path(SCALAR, "matrix", false)).toBe(";id=x%20y");
    expect(path(LIST, "matrix", false)).toBe(";id=a%20b,c");
    expect(path(LIST, "matrix", true)).toBe(";id=a%20b;id=c");
    expect(path(OBJECT, "matrix", false)).toBe(";id=R,100,G,2%200");
    expect(path(OBJECT, "matrix", true)).toBe(";R=100;G=2%200");
    // A header value isn't percent-encoded.
    expect(templateValue("X", LIST, "simple", false, (text) => text)).toBe(
      "a b,c"
    );
  });
});

describe("parameters on the wire", () => {
  it("applies the OpenAPI defaults: form + explode in a query, simple elsewhere", () => {
    const model = buildModel({
      parameters: [
        {
          example: [1, 2],
          in: "path",
          name: "ids",
          schema: { items: { type: "integer" }, type: "array" },
        },
        {
          example: ["dog", "cat"],
          in: "query",
          name: "tags",
          required: true,
          schema: { items: { type: "string" }, type: "array" },
        },
        {
          example: ["a", "b"],
          in: "header",
          name: "X-Tags",
          required: true,
          schema: { type: "array" },
        },
      ],
      path: "/pets/{ids}",
    });
    const built = request(model);
    expect(built.url).toBe("https://api.test/pets/1,2?tags=dog&tags=cat");
    expect(built.headers).toStrictEqual({ "X-Tags": "a,b" });
  });

  it("honors a declared style and explode", () => {
    const model = buildModel({
      parameters: [
        {
          example: { color: "red", size: "L" },
          in: "query",
          name: "filter",
          required: true,
          schema: { type: "object" },
          style: "deepObject",
        },
        {
          example: ["a", "b"],
          explode: false,
          in: "query",
          name: "ids",
          required: true,
          schema: { type: "array" },
        },
        {
          example: ["x", "y"],
          in: "query",
          name: "words",
          required: true,
          schema: { type: "array" },
          style: "spaceDelimited",
        },
        {
          example: [3, 4],
          explode: true,
          in: "path",
          name: "id",
          schema: { type: "array" },
          style: "matrix",
        },
      ],
      path: "/pets/{id}",
    });
    expect(model.params.map((param) => [param.style, param.explode])).toEqual([
      ["deepObject", undefined],
      [undefined, false],
      ["spaceDelimited", undefined],
      ["matrix", true],
    ]);
    expect(request(model).url).toBe(
      "https://api.test/pets/;id=3;id=4?filter[color]=red&filter[size]=L&ids=a,b&words=x%20y"
    );
  });

  it("keeps a GraphQL endpoint's trailing slash, strips it before a path", () => {
    const graphql: PlaygroundModel = {
      auth: [],
      authOptional: true,
      method: "POST",
      params: [],
      path: "",
      servers: ["https://host/graphql/"],
    };
    expect(request(graphql).url).toBe("https://host/graphql/");
    const rest = buildModel({ servers: [{ url: "https://api.test/v1/" }] });
    expect(request(rest).url).toBe("https://api.test/v1/pets");
  });
});

describe("bodies by media type", () => {
  it("classifies media types", () => {
    expect(bodyEncoding("application/json")).toBe("json");
    expect(bodyEncoding("application/vnd.api+json; charset=utf-8")).toBe(
      "json"
    );
    expect(bodyEncoding("Application/X-WWW-Form-Urlencoded")).toBe("form");
    expect(bodyEncoding("multipart/form-data")).toBe("multipart");
    expect(bodyEncoding("text/plain")).toBe("raw");
    expect(bodyEncoding("application/x-ndjson")).toBe("raw");
  });

  it("sends a form-urlencoded body as name=value pairs", () => {
    const model = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/x-www-form-urlencoded": {
            encoding: {
              ignored: "not an object",
              metadata: { explode: true, style: "deepObject" },
              plain: { contentType: "text/plain" },
            },
            example: {
              expand: ["customer", "invoice"],
              metadata: { order: "6735" },
              name: "Jenny Rosen",
            },
          },
        },
      },
    });
    expect(model.body?.encoding).toStrictEqual({
      metadata: { explode: true, style: "deepObject" },
    });
    const built = request(model);
    expect(built.body).toBe(
      "expand=customer&expand=invoice&metadata[order]=6735&name=Jenny%20Rosen"
    );
    expect(built.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(sample("curl", built)).toContain(
      "-d 'expand=customer&expand=invoice&metadata[order]=6735&name=Jenny%20Rosen'"
    );
    // No declared styles: no encoding in the model at all.
    const bare = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/x-www-form-urlencoded": {
            encoding: { name: {} },
            example: { name: "Rex" },
          },
        },
      },
    });
    expect(bare.body?.encoding).toBeUndefined();
    expect(request(bare).body).toBe("name=Rex");
    const undeclared = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/x-www-form-urlencoded": { example: { tags: ["a"] } },
        },
      },
    });
    expect(undeclared.body?.encoding).toBeUndefined();
    expect(request(undeclared).body).toBe("tags=a");
    // Text that isn't a JSON object (mid-edit, a bare value) goes as written.
    const values = defaultValues(bare);
    expect(buildRequest(bare, { ...values, body: "{oops" }).body).toBe("{oops");
    expect(buildRequest(bare, { ...values, body: "[1]" }).body).toBe("[1]");
  });

  it("sends a multipart body as parts, in every sample", () => {
    const model = buildModel({
      method: "post",
      requestBody: {
        content: {
          "multipart/form-data": {
            example: { name: "Rex", tags: ["a", "b"] },
          },
        },
      },
    });
    const built = request(model);
    expect(built.body).toBeUndefined();
    expect(built.formData).toStrictEqual([
      ["name", "Rex"],
      ["tags", "a"],
      ["tags", "b"],
    ]);
    // curl, fetch, and requests all write the boundary Content-Type.
    expect(built.headers).toStrictEqual({});
    expect(sample("curl", built)).toBe(
      [
        "curl -X POST 'https://api.test/pets'",
        "  --form-string 'name=Rex'",
        "  --form-string 'tags=a'",
        "  --form-string 'tags=b'",
      ].join(" \\\n")
    );
    expect(sample("js", built)).toBe(
      [
        "const form = new FormData();",
        'form.append("name", "Rex");',
        'form.append("tags", "a");',
        'form.append("tags", "b");',
        "",
        'const response = await fetch("https://api.test/pets", {',
        '  method: "POST",',
        "  body: form",
        "});",
      ].join("\n")
    );
    expect(sample("python", built)).toBe(
      [
        "import requests",
        "",
        "response = requests.post(",
        '    "https://api.test/pets",',
        "    files=[",
        '        ("name", (None, "Rex")),',
        '        ("tags", (None, "a")),',
        '        ("tags", (None, "b")),',
        "    ],",
        ")",
      ].join("\n")
    );
  });

  it("sends a raw media type's text as written", () => {
    const model = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/xml": {
            example: "<pet/>",
            schema: {
              properties: { name: { type: "string" } },
              type: "object",
            },
          },
        },
      },
    });
    // An object schema still gets no typed fields: they would assemble JSON.
    expect(model.body?.fields).toBeUndefined();
    expect(model.body?.example).toBe("<pet/>");
    const built = request(model);
    expect(built.body).toBe("<pet/>");
    expect(built.bodyValue).toBeUndefined();
    expect(built.headers["Content-Type"]).toBe("application/xml");
    // A non-string example still prefills as JSON.
    const numeric = buildModel({
      method: "post",
      requestBody: { content: { "text/plain": { example: 42 } } },
    });
    expect(numeric.body?.example).toBe("42");
  });
});

describe("request samples", () => {
  it("uses --head for HEAD and requests.request for TRACE", () => {
    const head = request(buildModel({ method: "head" }));
    expect(sample("curl", head)).toBe("curl --head 'https://api.test/pets'");
    const trace = request(buildModel({ method: "trace" }));
    expect(sample("curl", trace)).toBe("curl -X TRACE 'https://api.test/pets'");
    expect(sample("python", trace)).toBe(
      [
        "import requests",
        "",
        "response = requests.request(",
        '    "TRACE",',
        '    "https://api.test/pets",',
        ")",
      ].join("\n")
    );
    expect(sample("python", request(buildModel()))).toContain("requests.get(");
  });
});

describe("referenced examples", () => {
  it("resolves examples that $ref #/components/examples", () => {
    const components = {
      examples: {
        Pet: { value: { name: "Rex" } },
        PetId: { value: 42 },
      },
    };
    const model = buildModel({
      components,
      method: "post",
      parameters: [
        {
          examples: { id: { $ref: "#/components/examples/PetId" } },
          in: "path",
          name: "id",
          schema: { type: "integer" },
        },
      ],
      path: "/pets/{id}",
      requestBody: {
        content: {
          "application/json": {
            examples: {
              missing: { $ref: "#/components/examples/Nope" },
              pet: { $ref: "#/components/examples/Pet" },
            },
            schema: { type: "object" },
          },
        },
      },
    });
    expect(model.params[0]?.value).toBe("42");
    expect(model.body?.example).toBe('{\n  "name": "Rex"\n}');
  });
});
