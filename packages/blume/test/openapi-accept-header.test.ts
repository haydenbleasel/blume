import { describe, expect, it } from "bun:test";

import {
  acceptHeader,
  operationModel,
} from "../src/components/openapi/operation-model.ts";
import {
  buildRequest,
  defaultValues,
} from "../src/components/openapi/request.ts";
import { sampleLanguages } from "../src/components/openapi/snippets.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";

/**
 * Try it and the code samples ask for the JSON an operation answers with. A
 * request without `Accept` reads as a browser's to Laravel and the like, so
 * an unauthenticated call got a 500 from a login redirect, not a 401.
 */

const security = { alternatives: [], optional: false };

describe("the Accept header", () => {
  it("names the first JSON response type, success responses first", () => {
    // Status keys read in numeric order, so `401` comes before `2XX`.
    expect(
      acceptHeader({
        "2XX": {
          content: {
            "application/vnd.api+json; charset=utf-8": {},
            "text/csv": {},
          },
        },
        "401": { content: { "application/problem+json": {} } },
      })
    ).toBe("application/vnd.api+json");
    expect(
      acceptHeader({
        "204": {},
        default: { content: { "application/json": {} } },
      })
    ).toBe("application/json");
    expect(acceptHeader({ "200": { content: { "text/plain": {} } } })).toBe(
      undefined
    );
    expect(acceptHeader()).toBeUndefined();
  });

  it("goes out with Send and every code sample", () => {
    const model = operationModel({
      method: "get",
      parameters: [],
      path: "/user",
      responses: { "200": { content: { "application/json": {} } } },
      schemas: {},
      security,
      servers: [{ url: "https://api.test" }],
      strings: EN_UI.reference,
    });
    const sample = buildRequest(model, defaultValues(model));
    expect(sample.headers).toStrictEqual({ Accept: "application/json" });
    const [curl] = sampleLanguages(["curl"]);
    expect(curl?.build(sample)).toContain("-H 'Accept: application/json'");
  });

  it("defers to an Accept header parameter, and is absent without JSON", () => {
    const declared = operationModel({
      method: "get",
      parameters: [
        {
          example: "text/csv",
          in: "header",
          name: "accept",
          required: true,
          schema: { type: "string" },
        },
      ],
      path: "/report",
      responses: { "200": { content: { "application/json": {} } } },
      schemas: {},
      security,
      servers: [],
      strings: EN_UI.reference,
    });
    expect(buildRequest(declared, defaultValues(declared)).headers).toEqual({
      accept: "text/csv",
    });
    const plain = operationModel({
      method: "get",
      parameters: [],
      path: "/ping",
      schemas: {},
      security,
      servers: [],
      strings: EN_UI.reference,
    });
    expect(plain.accept).toBeUndefined();
    expect(buildRequest(plain, defaultValues(plain)).headers).toEqual({});
  });
});
