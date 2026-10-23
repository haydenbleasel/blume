import { describe, expect, it } from "bun:test";

import {
  payloadPanels,
  preferredMedia,
  responsePanels,
} from "../src/components/openapi/example-panels.ts";
import { namedExamples } from "../src/components/openapi/helpers.ts";
import type { SchemaLike } from "../src/components/openapi/helpers.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";

/**
 * Every example a media type names shows, under its name: the Response and
 * Payload tabs get one per named example, labeled by its `summary` (else its
 * key) after the status or media type, as statuses already get one each.
 */

const schemas = {
  User: {
    properties: {
      id: { readOnly: true, type: "integer" },
      name: { type: "string" },
      password: { type: "string", writeOnly: true },
    },
    type: "object",
  },
} satisfies Record<string, SchemaLike>;
const user = { $ref: "#/components/schemas/User" };

const components = {
  examples: { admin: { summary: "An admin", value: { id: 1, name: "root" } } },
};

describe("named examples", () => {
  it("labels each by its summary, else its key, resolving $refs", () => {
    expect(
      namedExamples(
        {
          examples: {
            admin: { $ref: "#/components/examples/admin" },
            guest: { value: { id: 2, name: "guest", password: "x" } },
            missing: { summary: "No value" },
          },
          schema: user,
        },
        schemas,
        "response",
        components
      )
    ).toStrictEqual([
      { key: "admin", label: "An admin", value: { id: 1, name: "root" } },
      // A response leaves out the writeOnly password, as the table does.
      { key: "guest", label: "guest", value: { id: 2, name: "guest" } },
    ]);
  });

  it("names none when there's one, or an `example`", () => {
    // Scalar's upgrade files a 3.0 `example` as the lone entry `default`.
    expect(
      namedExamples({ examples: { default: { value: 1 } } }, schemas, "request")
    ).toStrictEqual([]);
    expect(
      namedExamples(
        { example: 1, examples: { a: { value: 1 }, b: { value: 2 } } },
        schemas,
        "request"
      )
    ).toStrictEqual([]);
    expect(namedExamples({ examples: [1, 2] }, schemas, "request")).toEqual([]);
  });
});

describe("response tabs", () => {
  it("shows every named example, after its status", () => {
    const panels = responsePanels(
      {
        "200": {
          content: {
            "application/json": {
              examples: {
                cat: { summary: "A cat", value: { name: "Tom" } },
                dog: { value: { name: "Rex" } },
              },
              schema: user,
            },
          },
          description: "OK",
        },
        "404": { description: "" },
      },
      schemas,
      EN_UI.reference.noExampleResponse,
      components
    );
    expect(panels).toStrictEqual([
      {
        key: "200-cat",
        label: "200 · A cat",
        name: "200",
        text: "OK",
        type: "application/json",
        value: { name: "Tom" },
      },
      {
        key: "200-dog",
        label: "200 · dog",
        name: "200",
        text: "OK",
        type: "application/json",
        value: { name: "Rex" },
      },
      {
        key: "404",
        label: "404",
        name: "404",
        text: "No example response.",
        type: "",
        value: undefined,
      },
    ]);
  });

  it("keeps one tab per status when the body has one example", () => {
    expect(
      responsePanels(
        {
          "201": {
            content: {
              "application/xml": { example: "<made/>" },
              "text/json": { schema: user },
            },
            description: "Created",
          },
        },
        schemas,
        EN_UI.reference.noExampleResponse
      )
    ).toStrictEqual([
      {
        key: "201",
        label: "201",
        name: "201",
        text: "Created",
        type: "text/json",
        value: { id: 0, name: "string" },
      },
    ]);
  });
});

describe("payload tabs", () => {
  it("shows every named example, after its media type", () => {
    expect(
      payloadPanels(
        {
          "application/json": {
            examples: {
              created: { value: { name: "a" } },
              deleted: { value: { name: "b" } },
            },
          },
          "text/plain": { example: "ping" },
        },
        schemas,
        EN_UI.reference.noExamplePayload
      ).map((panel) => [panel.key, panel.label, panel.value])
    ).toStrictEqual([
      ["application/json-created", "application/json · created", { name: "a" }],
      ["application/json-deleted", "application/json · deleted", { name: "b" }],
      ["text/plain", "text/plain", "ping"],
    ]);
    expect(
      payloadPanels(undefined, schemas, EN_UI.reference.noExamplePayload)
    ).toStrictEqual([]);
  });

  it("picks a body's JSON media type, else its first", () => {
    expect(preferredMedia({ "text/csv": {}, "text/xml": {} })?.[0]).toBe(
      "text/csv"
    );
    expect(preferredMedia()).toBeUndefined();
  });
});
