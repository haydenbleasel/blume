import { describe, expect, it } from "bun:test";

import {
  asyncSampleLanguages,
  webSocketUrl,
} from "../src/components/openapi/async-snippets.ts";
import type { NamedMessage } from "../src/components/openapi/async.ts";
import type { ParameterLike } from "../src/components/openapi/helpers.ts";
import { messageModel } from "../src/components/openapi/message-model.ts";
import {
  buildMessage,
  defaultMessageValues,
  messageFrame,
} from "../src/components/openapi/message.ts";

/**
 * The event composer's shared model: derivation from a spec
 * (`message-model.ts`) and the one builder the samples, the connect URL, and
 * the live frame all consume (`message.ts`). The equivalence test is the
 * load-bearing one — it proves a copied `wscat` command carries the same URL
 * and the same payload bytes the panel would put on the wire.
 */

type ModelArgs = Parameters<typeof messageModel>[0];

const named = (
  message: NamedMessage["message"],
  key = "message"
): NamedMessage => ({ key, message });

/** A message model with boring defaults, so tests state only what matters. */
const buildModel = (overrides: Partial<ModelArgs> = {}) =>
  messageModel({
    action: "receive",
    address: "user/signedup",
    messages: [],
    parameters: [],
    protocol: "ws",
    schemas: {},
    servers: [{ host: "events.test", protocol: "wss" }],
    ...overrides,
  });

const WSCAT = /^wscat -c '(?<url>[^']+)'\n> (?<payload>[\s\S]*)$/u;

describe("messageModel", () => {
  it("prefills channel parameters from default, example, then schema", () => {
    const parameters: ParameterLike[] = [
      {
        description: "Tenant slug.",
        in: "channel",
        name: "tenant",
        required: true,
        schema: { default: "acme", enum: ["acme", "globex"], type: "string" },
      },
      { example: "42", in: "channel", name: "userId", required: true },
      { in: "channel", name: "region", required: true },
    ];
    expect(buildModel({ parameters }).params).toStrictEqual([
      {
        description: "Tenant slug.",
        enum: ["acme", "globex"],
        name: "tenant",
        value: "acme",
      },
      { description: undefined, enum: undefined, name: "userId", value: "42" },
      {
        description: undefined,
        enum: undefined,
        name: "region",
        value: "",
      },
    ]);
  });

  it("names a parameter-less entry rather than dropping it", () => {
    // `channelParameters` always sets a name; a hand-built model must still
    // produce a stable key instead of `undefined`.
    expect(
      buildModel({ parameters: [{ in: "channel", required: true }] }).params[0]
        ?.name
    ).toBe("");
  });

  it("prefers a declared payload example over a sampled one", () => {
    const model = buildModel({
      messages: [
        named({
          contentType: "application/json",
          examples: [{ payload: { id: "declared" } }],
          payload: { properties: { id: { type: "string" } }, type: "object" },
        }),
      ],
    });
    expect(model.payload.contentType).toBe("application/json");
    expect(JSON.parse(model.payload.example)).toStrictEqual({
      id: "declared",
    });
  });

  it("samples the payload schema when no example is declared, with a pruned validator", () => {
    const model = buildModel({
      messages: [
        named({
          payload: {
            properties: { id: { type: "string" } },
            required: ["id"],
            type: "object",
          },
        }),
      ],
    });
    expect(JSON.parse(model.payload.example)).toStrictEqual({ id: "string" });
    expect(model.payload.schema).toStrictEqual({
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    });
  });

  it("leaves the payload empty when the operation has no message", () => {
    expect(buildModel().payload).toStrictEqual({ example: "" });
  });

  it("labels servers by protocol and path, falling back to the bare host", () => {
    expect(
      buildModel({
        servers: [
          { host: "events.test", pathname: "/mqtt", protocol: "wss" },
          { host: "broker:9092" },
        ],
      }).servers.map((option) => option.label)
    ).toStrictEqual(["wss://events.test/mqtt", "broker:9092"]);
  });

  it("offers a live connection for WebSocket bindings only", () => {
    expect(buildModel().connectable).toBeTrue();
    expect(buildModel({ protocol: "kafka" }).connectable).toBeFalse();
    expect(buildModel({ protocol: undefined }).connectable).toBeFalse();
  });
});

describe("buildMessage", () => {
  it("fills the address template with encoded parameter values", () => {
    const model = buildModel({
      address: "tenants/{tenant}/users/{userId}",
      parameters: [
        { in: "channel", name: "tenant", required: true },
        { in: "channel", name: "userId", required: true },
      ],
    });
    expect(
      buildMessage(model, {
        ...defaultMessageValues(model),
        params: { tenant: "acme corp", userId: "42" },
      }).address
    ).toBe("tenants/acme%20corp/users/42");
  });

  it("keeps the template for a parameter left blank", () => {
    const model = buildModel({
      address: "tenants/{tenant}/events",
      parameters: [{ in: "channel", name: "tenant", required: true }],
    });
    expect(buildMessage(model, defaultMessageValues(model)).address).toBe(
      "tenants/{tenant}/events"
    );
  });

  it("picks a server by index and falls back to the first when out of range", () => {
    const model = buildModel({
      servers: [{ host: "one.test" }, { host: "two.test" }],
    });
    const values = defaultMessageValues(model);
    expect(buildMessage(model, { ...values, server: 1 }).server?.host).toBe(
      "two.test"
    );
    expect(buildMessage(model, { ...values, server: 9 }).server?.host).toBe(
      "one.test"
    );
  });

  it("has no server at all when the spec declares none", () => {
    const model = buildModel({ servers: [] });
    expect(
      buildMessage(model, defaultMessageValues(model)).server
    ).toBeUndefined();
  });

  it("lowers a custom URL onto the server shape, host-only when unparseable", () => {
    const model = buildModel();
    const values = defaultMessageValues(model);
    expect(
      buildMessage(model, { ...values, customUrl: " ws://local.test/socket " })
        .server
    ).toStrictEqual({
      host: "local.test",
      pathname: "/socket",
      protocol: "ws",
    });
    expect(
      buildMessage(model, { ...values, customUrl: "wss://bare.test/" }).server
    ).toStrictEqual({ host: "bare.test", pathname: "", protocol: "wss" });
    // `broker:9092` parses as a scheme plus path, `events.test` doesn't parse
    // at all — both are addresses, not URLs, and stay whole as the host.
    expect(
      buildMessage(model, { ...values, customUrl: "broker:9092" }).server
    ).toStrictEqual({ host: "broker:9092" });
    expect(
      buildMessage(model, { ...values, customUrl: "events.test" }).server
    ).toStrictEqual({ host: "events.test" });
  });

  it("carries a parsed payload, and none at all when the text is broken", () => {
    const model = buildModel();
    const values = defaultMessageValues(model);
    expect(
      buildMessage(model, { ...values, payload: '{"id":"1"}' }).payload
    ).toStrictEqual({ id: "1" });
    expect(
      buildMessage(model, { ...values, payload: "{oops" }).payload
    ).toBeUndefined();
  });
});

describe("messageFrame", () => {
  it("renders wscat samples that carry exactly the frame the composer sends", () => {
    const cases: { overrides: Partial<ModelArgs>; payload: string }[] = [
      {
        overrides: {
          address: "tenants/{tenant}/signedup",
          messages: [
            named({ examples: [{ payload: { note: "it's alive" } }] }),
          ],
          parameters: [{ in: "channel", name: "tenant", required: true }],
        },
        payload: '{"note":"it\'s alive"}',
      },
      {
        overrides: {
          messages: [named({ examples: [{ payload: [1, 2, 3] }] })],
          servers: [{ host: "events.test", pathname: "/v1", protocol: "ws" }],
        },
        payload: "[1,2,3]",
      },
      { overrides: {}, payload: "{}" },
    ];
    for (const { overrides, payload } of cases) {
      const model = buildModel(overrides);
      const sample = buildMessage(model, defaultMessageValues(model));
      const [wscat] = asyncSampleLanguages(["wscat"], "ws").map((language) =>
        language.build(sample)
      );
      const parsed = WSCAT.exec(wscat ?? "")?.groups;
      // The URL the sample connects to is the URL the composer connects to,
      // and the payload it embeds is byte-identical to the sent frame.
      expect(parsed?.url).toBe(webSocketUrl(sample));
      expect(parsed?.payload).toBe(messageFrame(sample));
      expect(messageFrame(sample)).toBe(payload);
    }
  });
});
