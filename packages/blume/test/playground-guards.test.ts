import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { operationModel } from "../src/components/openapi/operation-model.ts";
import { initPlayground } from "../src/components/openapi/playground-client.ts";
import { validationSchema } from "../src/components/openapi/playground-schema.ts";
import type { PlaygroundModel } from "../src/components/openapi/request.ts";
import { validateJson } from "../src/components/openapi/validate-json.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";
import {
  asElement,
  el,
  fire,
  installFakeDom,
  must,
  storage,
} from "./fake-dom.ts";
import type { FakeEl } from "./fake-dom.ts";

/**
 * Two ways the "Try it" panel used to refuse a request it should send: the
 * body validator demanding what the spec doesn't require of a request
 * (`readOnly` properties, `null` in a nullable field), and blocked storage
 * throwing during init so Send was never wired.
 */

let fetchCalls: string[] = [];
let restoreDom: () => void;

beforeAll(() => {
  restoreDom = installFakeDom({
    fetch: (url) => {
      fetchCalls.push(url);
      return Promise.resolve(new Response("{}"));
    },
  });
});

afterAll(() => {
  restoreDom();
});

afterEach(() => {
  fetchCalls = [];
  storage.clear();
});

const PET_SCHEMAS = {
  Owner: { properties: { name: { type: "string" } }, type: ["object", "null"] },
  Pet: {
    properties: {
      id: { readOnly: true, type: "string" },
      name: { type: "string" },
      nickname: { nullable: true, type: "string" },
      owner: { $ref: "#/components/schemas/Owner" },
      tags: { items: { type: "string" }, type: "array" },
    },
    required: ["id", "name"],
    type: "object",
  },
};

/** The model a body of `Pet` (nested, so the raw JSON editor) produces. */
const petModel = (): PlaygroundModel =>
  operationModel({
    method: "post",
    parameters: [],
    path: "/pets",
    requestBody: {
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
      },
    },
    schemas: PET_SCHEMAS,
    security: { alternatives: [], optional: false },
    servers: [{ url: "https://api.example.com" }],
    strings: EN_UI.reference,
  });

interface Fixture {
  bodyArea: FakeEl;
  bodyErrors: FakeEl;
  remember: FakeEl;
  response: FakeEl;
  root: FakeEl;
  sendButton: FakeEl;
  token: FakeEl;
}

/** The slice of Playground.astro's DOM these flows touch. */
const createFixture = (model: PlaygroundModel): Fixture => {
  const root = el("blume-playground", {
    "data-storage-key": "blume-playground:pets:add-pet",
  });
  root.append(
    el(
      "script",
      { "data-playground-model": "", type: "application/json" },
      JSON.stringify(model)
    ),
    el(
      "script",
      { "data-playground-strings": "", type: "application/json" },
      JSON.stringify(EN_UI.reference)
    )
  );
  const token = el("input", { "data-auth-value": "bearerAuth" });
  const remember = el("input", { "data-auth-remember": "", type: "checkbox" });
  const bodyArea = el("textarea", { "data-body": "" });
  bodyArea.value = model.body?.example ?? "";
  const bodyErrors = el("div", { "data-body-errors": "" });
  const sendButton = el("button", { "data-send": "" });
  const response = el("div", { "data-response": "" });
  root.append(token, remember, bodyArea, bodyErrors, sendButton, response);
  return { bodyArea, bodyErrors, remember, response, root, sendButton, token };
};

const clickSend = async (fixture: Fixture): Promise<void> => {
  await Promise.all(fire(fixture.sendButton, "click", fixture.sendButton));
};

describe("request body validation", () => {
  it("sends the untouched prefill of a body with a required readOnly id", async () => {
    const model = petModel();
    // The prefill leaves the server-generated id out…
    expect(model.body?.example).not.toContain('"id"');
    const fixture = createFixture(model);
    initPlayground(asElement(fixture.root));
    await clickSend(fixture);
    // …and the validator no longer demands it back.
    expect(fixture.bodyErrors.textContent).toBe("");
    expect(fetchCalls).toStrictEqual(["https://api.example.com/pets"]);
  });

  it("accepts null in nullable fields and still rejects it elsewhere", () => {
    const schema = validationSchema(
      { $ref: "#/components/schemas/Pet" },
      PET_SCHEMAS
    );
    expect(schema?.required).toStrictEqual(["name"]);
    expect(
      validateJson(
        '{"name":"Rex","nickname":null,"owner":null}',
        EN_UI.reference,
        schema
      )
    ).toStrictEqual([]);
    expect(
      validateJson('{"name":null}', EN_UI.reference, schema)
    ).toStrictEqual(["body.name should be string, got null"]);
  });

  it("checks no single type for a multi-type field", () => {
    const schema = validationSchema(
      {
        properties: { size: { type: ["string", "integer"] } },
        type: "object",
      },
      {}
    );
    expect(schema?.properties?.size?.type).toBeUndefined();
    expect(validateJson('{"size":3}', EN_UI.reference, schema)).toStrictEqual(
      []
    );
    expect(validateJson('{"size":"L"}', EN_UI.reference, schema)).toStrictEqual(
      []
    );
  });
});

/** Make every `localStorage` read throw, as Safari and sandboxes do. */
const blockStorage = (): (() => void) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
  return () => {
    Object.defineProperty(globalThis, "localStorage", must(saved));
  };
};

describe("blocked storage", () => {
  it("initializes, remembers nothing, and still sends", async () => {
    const unblock = blockStorage();
    try {
      const fixture = createFixture(petModel());
      expect(() => initPlayground(asElement(fixture.root))).not.toThrow();
      // Checking and unchecking "Remember", and typing a token while it is
      // checked, all reach storage — none of them may throw.
      fixture.remember.checked = true;
      fire(fixture.root, "change", fixture.remember);
      fixture.token.value = "secret";
      fire(fixture.root, "input", fixture.token);
      fixture.remember.checked = false;
      fire(fixture.root, "change", fixture.remember);
      await clickSend(fixture);
      expect(fetchCalls).toHaveLength(1);
    } finally {
      unblock();
    }
    expect(storage.size).toBe(0);
  });

  it("drops a corrupt remembered entry even when removal is what throws", () => {
    storage.set("blume-playground:pets:add-pet", "{not json");
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
      },
    });
    try {
      const fixture = createFixture(petModel());
      expect(() => initPlayground(asElement(fixture.root))).not.toThrow();
      expect(fixture.remember.checked).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "localStorage", must(saved));
    }
  });
});
