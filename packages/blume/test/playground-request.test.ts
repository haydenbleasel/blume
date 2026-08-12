import { describe, expect, it } from "bun:test";

import type { SchemaLike } from "../src/components/openapi/helpers.ts";
import { operationModel } from "../src/components/openapi/operation-model.ts";
import {
  buildRequest,
  defaultValues,
  paramKey,
  redactAuth,
} from "../src/components/openapi/request.ts";
import type { PlaygroundAuthInput } from "../src/components/openapi/request.ts";
import { resolveSecurity } from "../src/components/openapi/security.ts";
import { sampleLanguages } from "../src/components/openapi/snippets.ts";
import { validateJson } from "../src/components/openapi/validate-json.ts";

const SCHEMES = {
  apiCookie: { in: "cookie", name: "session", type: "apiKey" },
  apiCookie2: { in: "cookie", name: "tracker", type: "apiKey" },
  apiHeader: { in: "header", name: "X-Api-Key", type: "apiKey" },
  apiQuery: { in: "query", name: "api_key", type: "apiKey" },
  bareKey: { type: "apiKey" },
  basicAuth: { scheme: "basic", type: "http" },
  bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
  digestAuth: { scheme: "digest", type: "http" },
  oauth: { type: "oauth2" },
  oidc: { type: "openIdConnect" },
  plainHttp: { type: "http" },
  tls: { type: "mutualTLS" },
};

type ModelArgs = Parameters<typeof operationModel>[0];

/** An operation model with boring defaults, so tests state only what matters. */
const buildModel = (overrides: Partial<ModelArgs> = {}) =>
  operationModel({
    method: "get",
    parameters: [],
    path: "/pets",
    schemas: {},
    security: { alternatives: [], optional: false },
    servers: [{ url: "https://api.test/v1" }],
    ...overrides,
  });

const CURL_FIRST = /^curl -X (?<method>\S+) "(?<url>[^"]+)"$/u;
const CURL_HEADER = /^ {2}-H "(?<key>[^:]+): (?<value>.*)"$/u;
const CURL_BODY = /^ {2}-d '(?<body>[\s\S]*)'$/u;

/**
 * Parse a rendered curl snippet back into the request it encodes. The reverse
 * direction of `curlSnippet`, used to prove the sample IS the fetch request.
 */
const parseCurl = (snippet: string) => {
  const segments = snippet.split(" \\\n");
  const first = CURL_FIRST.exec(segments[0] ?? "");
  const headers: Record<string, string> = {};
  let body: string | undefined;
  for (const segment of segments.slice(1)) {
    const header = CURL_HEADER.exec(segment);
    if (header?.groups) {
      headers[header.groups.key ?? ""] = header.groups.value ?? "";
      continue;
    }
    const data = CURL_BODY.exec(segment);
    if (data?.groups) {
      // Undo the POSIX close-quote/escape/reopen dance for literal quotes.
      body = (data.groups.body ?? "").replaceAll(String.raw`'\''`, "'");
    }
  }
  return {
    body,
    headers,
    method: first?.groups?.method,
    url: first?.groups?.url,
  };
};

describe("buildRequest", () => {
  it("renders curl samples that parse back to exactly the fetch request", () => {
    const cases: Partial<ModelArgs>[] = [
      // Path + query + header params under bearer auth.
      {
        parameters: [
          {
            example: 42,
            in: "path",
            name: "petId",
            schema: { type: "integer" },
          },
          {
            in: "query",
            name: "verbose",
            required: true,
            schema: { type: "boolean" },
          },
          { example: "trace-1", in: "header", name: "X-Trace", required: true },
        ],
        path: "/pets/{petId}",
        security: resolveSecurity([{ bearerAuth: [] }], SCHEMES),
      },
      // API key carried in the query string.
      {
        parameters: [
          { example: "cats", in: "query", name: "q", required: true },
        ],
        security: resolveSecurity([{ apiQuery: [] }], SCHEMES),
      },
      // JSON body containing a single quote, under basic auth.
      {
        method: "post",
        requestBody: {
          content: {
            "application/json": { example: { note: "it's alive" } },
          },
        },
        security: resolveSecurity([{ basicAuth: [] }], SCHEMES),
      },
      // Cookie- and header-carried API keys together.
      {
        security: resolveSecurity([{ apiCookie: [], apiHeader: [] }], SCHEMES),
      },
    ];
    for (const overrides of cases) {
      const model = buildModel(overrides);
      const sample = buildRequest(model, defaultValues(model));
      const [curl] = sampleLanguages(["curl"]).map((language) =>
        language.build(sample)
      );
      expect(parseCurl(curl ?? "")).toStrictEqual({
        body: sample.body,
        headers: sample.headers,
        method: sample.method,
        url: sample.url,
      });
    }
  });

  it("prefills required params from examples and leaves optional ones out", () => {
    const model = buildModel({
      parameters: [
        {
          in: "query",
          name: "limit",
          required: true,
          schema: { example: 25, type: "integer" },
        },
        // Optional params stay blank even when the spec has an example, so
        // default samples carry required params only.
        { example: "ignored", in: "query", name: "filter" },
        { in: "header", name: "X-Optional", schema: { type: "string" } },
      ],
    });
    expect(paramKey({ in: "query", name: "limit" })).toBe("query:limit");
    const values = defaultValues(model);
    expect(values.params["query:limit"]).toBe("25");
    expect(values.params["query:filter"]).toBe("");
    expect(values.params["header:X-Optional"]).toBe("");
    expect(values.server).toBe("https://api.test/v1");
    expect(values.body).toBeUndefined();
    const sample = buildRequest(model, values);
    expect(sample.url).toBe("https://api.test/v1/pets?limit=25");
    expect(sample.headers).toStrictEqual({});
  });

  it("redacts credentials so samples never leak the real value", () => {
    const model = buildModel({
      security: resolveSecurity([{ bearerAuth: [] }], SCHEMES),
    });
    const values = defaultValues(model);
    values.auth.bearerAuth = { value: "sekret-token" };
    expect(buildRequest(model, values).headers.Authorization).toBe(
      "Bearer sekret-token"
    );
    const redacted = redactAuth(model, values);
    // Non-auth values survive redaction untouched.
    expect(redacted.server).toBe(values.server);
    expect(redacted.params).toBe(values.params);
    const sample = buildRequest(model, redacted);
    expect(sample.headers.Authorization).toBe("Bearer YOUR_TOKEN");
    const [curl] = sampleLanguages(["curl"]).map((language) =>
      language.build(sample)
    );
    expect(curl).not.toContain("sekret-token");
  });

  it("encodes basic credentials with btoa, placeholder until filled", () => {
    const model = buildModel({
      security: resolveSecurity([{ basicAuth: [] }], SCHEMES),
    });
    const values = defaultValues(model);
    expect(buildRequest(model, values).headers.Authorization).toBe(
      "Basic YOUR_CREDENTIALS"
    );
    values.auth.basicAuth = {
      password: "opensesame",
      username: "aladdin",
      value: "",
    };
    expect(buildRequest(model, values).headers.Authorization).toBe(
      `Basic ${btoa("aladdin:opensesame")}`
    );
    // A lone username still encodes — servers reject it, but visibly.
    values.auth.basicAuth = { username: "aladdin", value: "" };
    expect(buildRequest(model, values).headers.Authorization).toBe(
      `Basic ${btoa("aladdin:")}`
    );
  });

  it("joins cookie-carried api keys into one Cookie header", () => {
    const model = buildModel({
      security: resolveSecurity([{ apiCookie: [], apiCookie2: [] }], SCHEMES),
    });
    const values = defaultValues(model);
    values.auth.apiCookie = { value: "abc123" };
    const sample = buildRequest(model, values);
    expect(sample.headers.Cookie).toBe("session=abc123; tracker=YOUR_API_KEY");
    expect(sample.url).toBe("https://api.test/v1/pets");
  });

  it("URL-encodes parameter and credential values", () => {
    const model = buildModel({
      parameters: [
        { in: "path", name: "id", schema: { type: "string" } },
        { in: "query", name: "q", required: true },
      ],
      path: "/pets/{id}",
      security: resolveSecurity([{ apiQuery: [] }], SCHEMES),
    });
    const values = defaultValues(model);
    values.params["path:id"] = "a/b";
    values.params["query:q"] = "a b";
    values.auth.apiQuery = { value: "k& y" };
    expect(buildRequest(model, values).url).toBe(
      "https://api.test/v1/pets/a%2Fb?q=a%20b&api_key=k%26%20y"
    );
  });

  it("falls back to raw names for blank values and strips base slashes", () => {
    const model = buildModel({
      parameters: [
        { in: "path", name: "petId", schema: { type: "integer" } },
        { in: "query", name: "q", required: true },
        { in: "header", name: "X-Trace", required: true },
      ],
      path: "/pets/{petId}",
    });
    // Missing keys read as "": path templates by name, query/header dropped.
    const sample = buildRequest(model, {
      ...defaultValues(model),
      params: {},
      server: "https://api.test/v2///",
    });
    expect(sample.url).toBe("https://api.test/v2/pets/petId");
    expect(sample.headers).toStrictEqual({});
  });

  it("sends the body verbatim, mirroring parseable JSON into bodyValue", () => {
    const model = buildModel({
      method: "post",
      requestBody: {
        content: { "application/json": { example: { name: "Rex" } } },
      },
    });
    const values = defaultValues(model);
    const sample = buildRequest(model, values);
    expect(sample.headers["Content-Type"]).toBe("application/json");
    expect(sample.body).toBe('{\n  "name": "Rex"\n}');
    expect(sample.bodyValue).toStrictEqual({ name: "Rex" });

    // Mid-edit invalid JSON still goes on the wire, without the mirror.
    const raw = buildRequest(model, { ...values, body: "{oops" });
    expect(raw.body).toBe("{oops");
    expect(raw.bodyValue).toBeUndefined();
    expect(raw.headers["Content-Type"]).toBe("application/json");

    // A cleared editor sends no body at all.
    const empty = buildRequest(model, { ...values, body: "" });
    expect(empty.body).toBeUndefined();
    expect(empty.headers["Content-Type"]).toBeUndefined();
  });
});

describe("operationModel", () => {
  it("maps security schemes to auth inputs", () => {
    const inputsFor = (requirement: Record<string, string[]>) =>
      buildModel({ security: resolveSecurity([requirement], SCHEMES) }).auth;
    const authorization: PlaygroundAuthInput["carrier"] = {
      in: "header",
      name: "Authorization",
    };
    expect(inputsFor({ bearerAuth: [] })).toStrictEqual([
      {
        carrier: authorization,
        id: "bearerAuth",
        kind: "bearer",
        label: "Bearer token (JWT)",
        placeholder: "YOUR_TOKEN",
        prefix: "Bearer ",
      },
    ]);
    expect(inputsFor({ basicAuth: [] })).toStrictEqual([
      {
        carrier: authorization,
        id: "basicAuth",
        kind: "basic",
        label: "Basic auth",
        placeholder: "YOUR_CREDENTIALS",
        prefix: "Basic ",
      },
    ]);
    // Other HTTP schemes: a bearer-like paste field with the scheme prefix.
    expect(inputsFor({ digestAuth: [] })).toStrictEqual([
      {
        carrier: authorization,
        id: "digestAuth",
        kind: "bearer",
        label: "HTTP digest",
        placeholder: "YOUR_CREDENTIALS",
        prefix: "Digest ",
      },
    ]);
    // http with no scheme declared defaults to bearer.
    expect(inputsFor({ plainHttp: [] })).toStrictEqual([
      {
        carrier: authorization,
        id: "plainHttp",
        kind: "bearer",
        label: "HTTP auth",
        placeholder: "YOUR_TOKEN",
        prefix: "Bearer ",
      },
    ]);
    // OAuth2 and OpenID Connect are token-paste fields — no flow.
    expect(inputsFor({ oauth: [] })).toStrictEqual([
      {
        carrier: authorization,
        id: "oauth",
        kind: "oauth2",
        label: "OAuth2 access token",
        placeholder: "YOUR_ACCESS_TOKEN",
        prefix: "Bearer ",
      },
    ]);
    expect(inputsFor({ oidc: [] })[0]?.kind).toBe("oauth2");
    expect(inputsFor({ apiHeader: [] })).toStrictEqual([
      {
        carrier: { in: "header", name: "X-Api-Key" },
        id: "apiHeader",
        kind: "apiKey",
        label: "API key",
        placeholder: "YOUR_API_KEY",
        prefix: "",
      },
    ]);
    expect(inputsFor({ apiQuery: [] })[0]?.carrier).toStrictEqual({
      in: "query",
      name: "api_key",
    });
    expect(inputsFor({ apiCookie: [] })[0]?.carrier).toStrictEqual({
      in: "cookie",
      name: "session",
    });
    // apiKey without in/name: header carrier named after the component key.
    expect(inputsFor({ bareKey: [] })[0]?.carrier).toStrictEqual({
      in: "header",
      name: "bareKey",
    });
    // Mutual TLS travels outside the request; unknown refs can't be guessed.
    expect(inputsFor({ tls: [] })).toStrictEqual([]);
    expect(inputsFor({ ghost: [] })).toStrictEqual([]);
    // First alternative only; an empty requirement flips authOptional.
    const model = buildModel({
      security: resolveSecurity(
        [{}, { apiHeader: [], bearerAuth: [] }, { apiQuery: [] }],
        SCHEMES
      ),
    });
    expect(model.auth.map((input) => input.id)).toStrictEqual([
      "apiHeader",
      "bearerAuth",
    ]);
    expect(model.authOptional).toBe(true);
    expect(buildModel().auth).toStrictEqual([]);
    expect(buildModel().authOptional).toBe(false);
  });

  it("skips cookie, nameless, and location-less parameters", () => {
    const model = buildModel({
      parameters: [
        { in: "cookie", name: "sid", required: true },
        { in: "query" },
        { example: "x", name: "weird" },
        {
          in: "query",
          name: "ok",
          required: true,
          schema: { enum: ["a", "b"] },
        },
      ],
    });
    expect(model.params.map((param) => param.name)).toStrictEqual(["ok"]);
    expect(model.params[0]?.enum).toStrictEqual(["a", "b"]);
    // Typeless schema labels as string; the sampler picks the first enum.
    expect(model.params[0]?.type).toBe("string");
    expect(model.params[0]?.value).toBe("a");
  });

  it("derives param types through $refs and stringifies defaults", () => {
    const model = buildModel({
      parameters: [
        {
          in: "query",
          name: "id",
          required: true,
          schema: { $ref: "#/components/schemas/Id" },
        },
        { example: true, in: "query", name: "flag", required: true },
        { example: null, in: "query", name: "n", required: true },
        { in: "path", name: "petId", schema: { type: "integer" } },
      ],
      path: "/pets/{petId}",
      schemas: { Id: { type: ["integer", "null"] } },
      servers: [{}],
    });
    expect(model.params[0]?.type).toBe("integer");
    expect(model.params[0]?.value).toBe("0");
    expect(model.params[1]?.value).toBe("true");
    // A null example has no sampler fallback (?? skips null): blank default.
    expect(model.params[2]?.value).toBe("");
    // Path params are required per spec even when the flag is omitted.
    expect(model.params[3]?.required).toBe(true);
    expect(model.params[3]?.value).toBe("0");
    // A server entry without a url still occupies its slot.
    expect(model.servers).toStrictEqual([""]);
    expect(model.method).toBe("GET");
  });

  it("emits typed fields for flat primitive bodies only", () => {
    const flat = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            example: { age: 3, name: "Rex" },
            schema: {
              properties: {
                age: { type: "integer" },
                name: { description: "Display name.", type: "string" },
                role: { enum: ["admin", "user"], type: "string" },
              },
              required: ["name"],
              type: "object",
            },
          },
        },
      },
    });
    expect(flat.body?.contentType).toBe("application/json");
    expect(flat.body?.fields).toStrictEqual([
      {
        description: undefined,
        enum: undefined,
        name: "age",
        required: false,
        type: "integer",
        value: "3",
      },
      {
        description: "Display name.",
        enum: undefined,
        name: "name",
        required: true,
        type: "string",
        value: "Rex",
      },
      {
        description: undefined,
        enum: ["admin", "user"],
        name: "role",
        required: false,
        type: "string",
        value: "",
      },
    ]);
    expect(flat.body?.example).toBe('{\n  "age": 3,\n  "name": "Rex"\n}');
    expect(flat.body?.schema).toStrictEqual({
      properties: {
        age: { type: "integer" },
        name: { type: "string" },
        role: { enum: ["admin", "user"], type: "string" },
      },
      required: ["name"],
      type: "object",
    });

    // A nested object property falls back to the raw JSON editor.
    const deep = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: {
                owner: {
                  properties: { name: { type: "string" } },
                  type: "object",
                },
              },
              type: "object",
            },
          },
        },
      },
    });
    expect(deep.body?.fields).toBeUndefined();
    expect(deep.body?.example).toContain("owner");

    // A typeless property hiding nested structure is still deep.
    const sneaky = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: { meta: { properties: { a: { type: "string" } } } },
              type: "object",
            },
          },
        },
      },
    });
    expect(sneaky.body?.fields).toBeUndefined();

    // Top-level arrays and property-less objects have no fields to explode.
    const list = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            schema: { items: { type: "string" }, type: "array" },
          },
        },
      },
    });
    expect(list.body?.fields).toBeUndefined();
    const bare = buildModel({
      method: "post",
      requestBody: {
        content: { "application/json": { schema: { type: "object" } } },
      },
    });
    expect(bare.body?.fields).toBeUndefined();

    // A non-object example contributes no field defaults.
    const scalarExample = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            example: 5,
            schema: {
              properties: { name: { type: "string" } },
              type: "object",
            },
          },
        },
      },
    });
    expect(scalarExample.body?.fields?.[0]?.value).toBe("");
  });

  it("merges allOf and $ref composition into flat fields", () => {
    const model = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/Base" },
                { properties: { note: { type: "string" } } },
              ],
            },
          },
        },
      },
      schemas: {
        Base: {
          properties: { id: { type: "integer" } },
          required: ["id"],
          type: "object",
        },
      },
    });
    expect(model.body?.fields?.map((field) => field.name)).toStrictEqual([
      "id",
      "note",
    ]);
    expect(model.body?.fields?.[0]?.required).toBe(true);
  });

  it("selects json-ish content, falling back to the first entry", () => {
    expect(buildModel().body).toBeUndefined();
    expect(buildModel({ requestBody: { content: {} } }).body).toBeUndefined();
    const plain = buildModel({
      method: "post",
      requestBody: { content: { "text/plain": { example: "hi" } } },
    });
    expect(plain.body?.contentType).toBe("text/plain");
    expect(plain.body?.example).toBe('"hi"');
    expect(plain.body?.fields).toBeUndefined();
    expect(plain.body?.schema).toBeUndefined();
    const multi = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": { example: { a: 1 } },
          "text/plain": {},
        },
      },
    });
    expect(multi.body?.contentType).toBe("application/json");
  });

  it("prunes validation schemas: refs resolved, cycles cut, depth capped", () => {
    // Self-referencing schema: the cyclic property is pruned out entirely.
    const node = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            example: {},
            schema: { $ref: "#/components/schemas/Node" },
          },
        },
      },
      schemas: {
        Node: {
          properties: {
            name: { type: "string" },
            next: { $ref: "#/components/schemas/Node" },
          },
          type: "object",
        },
      },
    });
    expect(node.body?.schema).toStrictEqual({
      properties: { name: { type: "string" } },
      type: "object",
    });

    // Two-schema cycle terminates; a ref reused by SIBLING branches is kept,
    // because the visited set is per-branch, not global.
    const twin = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            example: {},
            schema: {
              properties: {
                first: { $ref: "#/components/schemas/A" },
                second: { $ref: "#/components/schemas/A" },
              },
              type: "object",
            },
          },
        },
      },
      schemas: {
        A: {
          properties: { b: { $ref: "#/components/schemas/B" } },
          type: "object",
        },
        B: {
          properties: { a: { $ref: "#/components/schemas/A" } },
          type: "object",
        },
      },
    });
    const pruned = twin.body?.schema;
    expect(pruned?.properties?.first).toStrictEqual({
      properties: { b: { type: "object" } },
      type: "object",
    });
    expect(pruned?.properties?.second).toStrictEqual(pruned?.properties?.first);

    // Inline nesting deeper than the cap is cut without recursing forever.
    let nested: SchemaLike = { type: "object" };
    for (let level = 0; level < 10; level += 1) {
      nested = { properties: { child: nested }, type: "object" };
    }
    const capped = buildModel({
      method: "post",
      requestBody: {
        content: { "application/json": { example: {}, schema: nested } },
      },
    });
    let cursor = capped.body?.schema;
    let depth = 0;
    while (cursor?.properties?.child) {
      depth += 1;
      cursor = cursor.properties.child;
    }
    expect(depth).toBe(5);

    // Array items prune too, carrying enum members through.
    const array = buildModel({
      method: "post",
      requestBody: {
        content: {
          "application/json": {
            example: [],
            schema: { items: { enum: [1, 2], type: "integer" }, type: "array" },
          },
        },
      },
    });
    expect(array.body?.schema).toStrictEqual({
      items: { enum: [1, 2], type: "integer" },
      type: "array",
    });
  });
});

describe("validateJson", () => {
  it("reports JSON syntax errors as a single message", () => {
    const errors = validateJson("{nope");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Invalid JSON:");
  });

  it("passes anything without a schema", () => {
    expect(validateJson("5")).toStrictEqual([]);
  });

  it("checks primitive types", () => {
    expect(validateJson("5", { type: "integer" })).toStrictEqual([]);
    expect(validateJson("5.5", { type: "integer" })).toStrictEqual([
      "body should be integer, got number",
    ]);
    expect(validateJson("5.5", { type: "number" })).toStrictEqual([]);
    expect(validateJson('"x"', { type: "number" })).toStrictEqual([
      "body should be number, got string",
    ]);
    expect(validateJson("true", { type: "boolean" })).toStrictEqual([]);
    expect(validateJson("null", { type: "boolean" })).toStrictEqual([
      "body should be boolean, got null",
    ]);
    expect(validateJson('"x"', { type: "string" })).toStrictEqual([]);
    expect(validateJson("[]", { type: "object" })).toStrictEqual([
      "body should be object, got array",
    ]);
    expect(validateJson("{}", { type: "array" })).toStrictEqual([
      "body should be array, got object",
    ]);
    expect(validateJson("{}", { type: "object" })).toStrictEqual([]);
    expect(validateJson("[]", { type: "array" })).toStrictEqual([]);
    // A type keyword the pruned subset doesn't model: no opinion.
    expect(validateJson("null", { type: "null" })).toStrictEqual([]);
  });

  it("checks required properties recursively", () => {
    const schema = {
      properties: {
        pet: {
          properties: { name: { type: "string" } },
          required: ["name"],
          type: "object",
        },
      },
      required: ["pet"],
      type: "object",
    };
    expect(validateJson('{"pet":{"name":"Rex"}}', schema)).toStrictEqual([]);
    expect(validateJson("{}", schema)).toStrictEqual(["body.pet is required"]);
    expect(validateJson('{"pet":{}}', schema)).toStrictEqual([
      "body.pet.name is required",
    ]);
    expect(validateJson('{"pet":{"name":5}}', schema)).toStrictEqual([
      "body.pet.name should be string, got number",
    ]);
  });

  it("checks enum membership including structured members", () => {
    expect(validateJson('"admin"', { enum: ["admin", "user"] })).toStrictEqual(
      []
    );
    expect(validateJson('"root"', { enum: ["admin", "user"] })).toStrictEqual([
      'body must be one of: "admin", "user"',
    ]);
    expect(validateJson('{"a":1}', { enum: [{ a: 1 }] })).toStrictEqual([]);
  });

  it("validates array items with indexed paths", () => {
    const schema = { items: { type: "integer" }, type: "array" };
    expect(validateJson("[1,2]", schema)).toStrictEqual([]);
    expect(validateJson('[1,"x"]', schema)).toStrictEqual([
      "body[1] should be integer, got string",
    ]);
    // Arrays without an items schema have nothing to check.
    expect(validateJson("[1]", { type: "array" })).toStrictEqual([]);
  });

  it("stops descending after a type mismatch", () => {
    expect(
      validateJson("[]", { required: ["name"], type: "object" })
    ).toStrictEqual(["body should be object, got array"]);
  });
});
