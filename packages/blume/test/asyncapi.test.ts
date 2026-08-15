import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import type { MessageSample } from "../src/components/openapi/async-snippets.ts";
import { asyncSampleLanguages } from "../src/components/openapi/async-snippets.ts";
import {
  asyncApiSecurityEntries,
  bindingGroups,
  channelParameters,
  channelServers,
  messageLabel,
  operationMessages,
  payloadSchema,
  protocolOf,
} from "../src/components/openapi/async.ts";
import {
  resolveAsyncApiSecurity,
  schemeCarrier,
  schemeLabel,
} from "../src/components/openapi/security.ts";
import {
  applyAsyncApiTraits,
  asyncApiOperationObject,
  channelAddress,
  channelIdOf,
  extractAsyncApiOperations,
  normalizeAsyncApiDocument,
} from "../src/openapi/asyncapi.ts";
import type { AsyncApiDocument } from "../src/openapi/asyncapi.ts";
import type { ApiOperationRef, ApiSpecData } from "../src/openapi/model.ts";
import { operationObject } from "../src/openapi/model.ts";
import { InvalidSpecError, parseAsyncApiSpec } from "../src/openapi/parse.ts";
import { operationMdx } from "../src/openapi/render-mdx.ts";
import { openApiSource } from "../src/openapi/source.ts";

const ctx = (projectRoot: string) => ({
  cacheDir: join(projectRoot, ".blume/cache/openapi"),
  mode: "build" as const,
  projectRoot,
});

const tempSpec = async (contents: unknown): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-asyncapi-"));
  const file = join(dir, "spec.json");
  await writeFile(file, JSON.stringify(contents));
  return dir;
};

const indexedReference = {
  includeInLlms: true,
  includeInSearch: true,
  noindex: false,
} as const;

const asyncReference = {
  ...indexedReference,
  basePath: "",
  display: {
    codeSamples: [],
    expandSchemas: false,
    playground: { enabled: true, proxy: false },
  },
  kind: "asyncapi" as const,
  label: "Events",
  renderer: "blume" as const,
  route: "/events",
  slug: "events",
  spec: "spec.json",
};

/** A small but complete AsyncAPI 3.0 document exercising the whole surface. */
const ASYNC_SPEC_3 = {
  asyncapi: "3.0.0",
  channels: {
    ping: { address: null },
    userSignedup: {
      address: "user/signedup",
      bindings: { kafka: { bindingVersion: "0.5.0", topic: "user-signups" } },
      description: "User signup events",
      messages: {
        UserSignedUp: { $ref: "#/components/messages/UserSignedUp" },
      },
      parameters: {
        region: {
          default: "eu",
          description: "Deployment region",
          enum: ["eu", "us"],
        },
      },
      servers: [{ $ref: "#/servers/prod" }],
    },
  },
  components: {
    messages: {
      UserSignedUp: {
        contentType: "application/json",
        name: "UserSignedUp",
        payload: { $ref: "#/components/schemas/User" },
      },
    },
    schemas: {
      User: {
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
    },
    securitySchemes: { sasl: { type: "scramSha256" } },
  },
  info: {
    description: "Events API.",
    tags: [{ description: "User events", name: "Users" }],
    title: "Events",
    version: "2.0.0",
  },
  operations: {
    pingOp: { action: "send", channel: { $ref: "#/channels/ping" } },
    publishUserSignedup: {
      action: "receive",
      channel: { $ref: "#/channels/userSignedup" },
      messages: [{ $ref: "#/channels/userSignedup/messages/UserSignedUp" }],
      summary: "User signed up",
      tags: [{ name: "Users" }],
    },
  },
  servers: {
    prod: {
      host: "broker.example.com:9092",
      protocol: "kafka",
      security: [{ $ref: "#/components/securitySchemes/sasl" }],
    },
  },
} as unknown as AsyncApiDocument;

/** The 2.x fixture from the converter's own documented behavior. */
const ASYNC_SPEC_2 = {
  asyncapi: "2.6.0",
  channels: {
    "user/signedup": {
      parameters: {
        // A parameter schema 3.0 can't express: triggers a converter warning.
        userId: { description: "The user id", schema: { type: "string" } },
      },
      publish: {
        message: {
          name: "UserSignedUp",
          payload: { $ref: "#/components/schemas/User" },
        },
        operationId: "onUserSignup",
        summary: "User signed up",
        tags: [{ name: "Users" }],
      },
      subscribe: {
        message: { name: "Pong", payload: { type: "string" } },
      },
    },
  },
  components: {
    schemas: {
      User: { properties: { id: { type: "string" } }, type: "object" },
    },
  },
  info: { title: "Chat", version: "1.0.0" },
};

describe("parse.parseAsyncApiSpec", () => {
  it("passes a 3.x document through with traits applied", async () => {
    const dir = await tempSpec({
      asyncapi: "3.0.0",
      channels: {
        c: {
          address: "c",
          messages: {
            inline: {
              payload: { type: "object" },
              traits: [{ contentType: "application/json" }],
            },
            viaRef: { $ref: "#/components/messages/m" },
          },
        },
      },
      components: {
        messages: {
          m: { payload: { type: "string" }, traits: "not-an-array" },
        },
        operationTraits: {
          kafkaish: { bindings: { kafka: { groupId: "g" } } },
        },
      },
      info: { title: "T", version: "1" },
      operations: {
        op: {
          action: "send",
          bindings: { ws: {} },
          channel: { $ref: "#/channels/c" },
          traits: [
            { $ref: "#/components/operationTraits/kafkaish" },
            { $ref: "#/components/operationTraits/missing" },
            { summary: "From trait" },
            "not-an-object",
          ],
        },
      },
    });
    const { document, warnings } = await parseAsyncApiSpec(
      "spec.json",
      dir,
      {}
    );
    expect(warnings).toStrictEqual([]);
    const operation = document.operations?.op;
    expect(operation?.traits).toBeUndefined();
    // The operation's own bindings win over the trait's.
    expect(operation?.bindings).toStrictEqual({ ws: {} });
    expect(operation?.summary).toBe("From trait");
    const inline = document.channels?.c?.messages?.inline as Record<
      string,
      unknown
    >;
    expect(inline.contentType).toBe("application/json");
    expect(inline.traits).toBeUndefined();
    // Non-array `traits` stays untouched.
    const kept = document.components?.messages?.m as Record<string, unknown>;
    expect(kept.traits).toBe("not-an-array");
    await rm(dir, { force: true, recursive: true });
  });

  it("normalizes a 2.x document to 3.0 with the official converter", async () => {
    const dir = await tempSpec(ASYNC_SPEC_2);
    const { document, warnings } = await parseAsyncApiSpec(
      "spec.json",
      dir,
      {}
    );
    expect(document.asyncapi).toBe("3.0.0");
    // publish → receive (application point of view), explicit id kept.
    expect(document.operations?.onUserSignup?.action).toBe("receive");
    // subscribe → send, with the converter's deterministic synthesized id.
    expect(document.operations?.["user/signedup.subscribe"]?.action).toBe(
      "send"
    );
    // The lossy parameter conversion surfaces as a captured warning, not
    // stray console output.
    expect(warnings.some((w) => w.startsWith("Converting spec.json"))).toBe(
      true
    );
    await rm(dir, { force: true, recursive: true });
  });

  it("rejects a document without an asyncapi version", async () => {
    const dir = await tempSpec({ openapi: "3.1.0" });
    await expect(parseAsyncApiSpec("spec.json", dir, {})).rejects.toThrow(
      InvalidSpecError
    );
    await rm(dir, { force: true, recursive: true });
  });

  it("rejects a document the converter cannot lift", async () => {
    const dir = await tempSpec({ asyncapi: "9.9.9", info: {} });
    await expect(parseAsyncApiSpec("spec.json", dir, {})).rejects.toThrow(
      /could not be converted to AsyncAPI 3\.0/u
    );
    await rm(dir, { force: true, recursive: true });
  });
});

describe("asyncapi.extractAsyncApiOperations", () => {
  it("maps operations to tag-grouped routes with channel-address fallback", () => {
    const { operations, tags, warnings } = extractAsyncApiOperations(
      ASYNC_SPEC_3,
      "/events"
    );
    expect(warnings).toStrictEqual([]);
    expect(operations).toHaveLength(2);

    const signup = operations.find((op) => op.key === "publishusersignedup");
    expect(signup).toMatchObject({
      channelId: "userSignedup",
      deprecated: false,
      method: "receive",
      operationId: "publishUserSignedup",
      path: "user/signedup",
      route: "/events/users/publishusersignedup",
      summary: "User signed up",
      tag: "Users",
      tagSlug: "users",
    });

    // Untagged: groups under the channel address; null address falls back to
    // the channel id.
    const ping = operations.find((op) => op.key === "pingop");
    expect(ping).toMatchObject({
      method: "send",
      path: "ping",
      route: "/events/ping/pingop",
      tag: "ping",
    });

    // Declared info.tags metadata flows onto the extracted tag.
    expect(tags).toStrictEqual([
      { description: "", name: "ping", slug: "ping" },
      { description: "User events", name: "Users", slug: "users" },
    ]);
  });

  it("skips and reports operations without an action or a channel", () => {
    const { operations, warnings } = extractAsyncApiOperations(
      {
        channels: { c: { address: "c" } },
        operations: {
          bad: { channel: { $ref: "#/channels/c" } },
          broken: { action: "send", channel: { $ref: "#/channels/missing" } },
          noChannel: { action: "receive" },
          notAnObject: null,
        },
      } as unknown as AsyncApiDocument,
      "/events"
    );
    expect(operations).toStrictEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('"bad" declares no send/receive action');
    expect(warnings[1]).toContain('"broken" references a channel');
    expect(warnings[2]).toContain('"noChannel" references a channel');
  });

  it("dedupes colliding keys and handles a root-mounted route", () => {
    const document = {
      channels: { c: { address: "topic" } },
      operations: {
        "get.thing": { action: "send", channel: { $ref: "#/channels/c" } },
        "get/thing": { action: "receive", channel: { $ref: "#/channels/c" } },
      },
    } as unknown as AsyncApiDocument;
    const { operations } = extractAsyncApiOperations(document, "/");
    expect(operations.map((op) => op.key)).toStrictEqual([
      "get-thing",
      "get-thing-receive",
    ]);
    expect(operations[0]?.route).toBe("/topic/get-thing");
  });

  it("inlines component channel and operation refs at normalization", () => {
    const document = normalizeAsyncApiDocument({
      channels: {
        "user/signedup": { $ref: "#/components/channels/userSignedup" },
      },
      components: {
        channels: { userSignedup: { address: "user.signedup.v1" } },
        operations: {
          sendSignup: {
            action: "send",
            channel: { $ref: "#/channels/user~1signedup" },
          },
        },
      },
      operations: {
        dangling: { $ref: "#/components/operations/missing" },
        sendSignup: { $ref: "#/components/operations/sendSignup" },
      },
    } as unknown as AsyncApiDocument);
    const { operations, warnings } = extractAsyncApiOperations(
      document,
      "/events"
    );
    // The component channel's real address flows through, not the map key.
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      channelId: "user/signedup",
      method: "send",
      path: "user.signedup.v1",
    });
    // A ref normalization couldn't inline gets its own warning, not the
    // missing-action one.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"dangling" is a reference');
  });

  it("falls back to action + address for an id that slugifies to nothing", () => {
    const document = {
      channels: { c: { address: "topic" } },
      operations: {
        "!!!": { action: "send", channel: { $ref: "#/channels/c" } },
      },
    } as unknown as AsyncApiDocument;
    const { operations } = extractAsyncApiOperations(document, "/events");
    expect(operations[0]?.key).toBe("send-topic");
  });

  it("resolves pointer-escaped channel refs and titles", () => {
    expect(channelIdOf({ $ref: "#/channels/user~1signedup" })).toBe(
      "user/signedup"
    );
    expect(channelIdOf({ $ref: "#/channels/a~0b" })).toBe("a~b");
    expect(channelIdOf({})).toBeUndefined();
    expect(channelIdOf()).toBeUndefined();
    expect(channelAddress("id", { address: "addr" })).toBe("addr");
    expect(channelAddress("id", { address: null })).toBe("id");
    expect(channelAddress("id")).toBe("id");

    const document = {
      channels: { c: { address: "c" } },
      operations: {
        titled: {
          action: "send",
          channel: { $ref: "#/channels/c" },
          title: "Nice title",
        },
      },
    } as unknown as AsyncApiDocument;
    const { operations } = extractAsyncApiOperations(document, "/events");
    expect(operations[0]?.summary).toBe("Nice title");
  });

  it("resolves operation objects for refs (and nothing else)", () => {
    const ref = extractAsyncApiOperations(ASYNC_SPEC_3, "/events")
      .operations[0] as ApiOperationRef;
    expect(asyncApiOperationObject(ASYNC_SPEC_3, ref)?.action).toBeDefined();
    expect(
      asyncApiOperationObject(ASYNC_SPEC_3, { ...ref, operationId: undefined })
    ).toBeUndefined();
    expect(
      asyncApiOperationObject(ASYNC_SPEC_3, { ...ref, operationId: "nope" })
    ).toBeUndefined();
    // The OpenAPI resolver refuses AsyncAPI actions outright.
    const spec = { document: ASYNC_SPEC_3 } as unknown as ApiSpecData;
    expect(operationObject(spec, ref)).toBeUndefined();
  });

  it("applies traits without following message refs twice", () => {
    const document = {
      channels: {
        c: {
          messages: {
            direct: { $ref: "#/components/messages/m" },
          },
        },
      },
      components: {
        messages: {
          m: { payload: { type: "string" }, traits: [{ name: "Named" }] },
        },
      },
    } as unknown as AsyncApiDocument;
    applyAsyncApiTraits(document);
    const message = document.components?.messages?.m as Record<string, unknown>;
    expect(message.name).toBe("Named");
    // The channel-level `$ref` entry stays a bare ref.
    expect(document.channels?.c?.messages?.direct).toStrictEqual({
      $ref: "#/components/messages/m",
    });
  });
});

describe("components/openapi/async helpers", () => {
  const channel = ASYNC_SPEC_3.channels?.userSignedup;
  const operation = ASYNC_SPEC_3.operations?.publishUserSignedup;

  it("resolves operation messages through the channel and components", () => {
    const messages = operationMessages(operation, channel, ASYNC_SPEC_3);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.key).toBe("UserSignedUp");
    expect(messages[0]?.message.contentType).toBe("application/json");
    expect(messageLabel(messages[0] as never)).toBe("UserSignedUp");
  });

  it("falls back to every channel message when the operation names none", () => {
    const messages = operationMessages(
      { action: "receive" },
      channel,
      ASYNC_SPEC_3
    );
    expect(messages.map((named) => named.key)).toStrictEqual(["UserSignedUp"]);
  });

  it("drops unresolvable and malformed message refs", () => {
    const messages = operationMessages(
      {
        messages: [
          { $ref: "#/channels/userSignedup/messages/Missing" },
          { $ref: "#/components/messages/Missing" },
          { payload: { type: "object" }, title: "Inline" },
          "not-an-object",
        ],
      } as never,
      channel,
      ASYNC_SPEC_3
    );
    expect(messages).toHaveLength(1);
    expect(messageLabel(messages[0] as never)).toBe("Inline");
    // No channel at all: nothing to fall back to.
    expect(operationMessages({}, undefined, ASYNC_SPEC_3)).toStrictEqual([]);
  });

  it("unwraps multi-format payloads only when they are JSON-schema-ish", () => {
    expect(payloadSchema({ payload: { type: "object" } })).toStrictEqual({
      type: "object",
    });
    expect(
      payloadSchema({
        payload: {
          schema: { type: "string" },
          schemaFormat: "application/schema+json;version=draft-07",
        },
      })
    ).toStrictEqual({ type: "string" });
    expect(
      payloadSchema({
        payload: {
          schema: "not-json",
          schemaFormat: "application/vnd.apache.avro;version=1.9.0",
        },
      })
    ).toBeUndefined();
    // Avro's `+json` encoding is JSON but not JSON Schema — no unwrap.
    expect(
      payloadSchema({
        payload: {
          schema: { fields: [{ name: "id" }], name: "User", type: "record" },
          schemaFormat: "application/vnd.apache.avro+json;version=1.9.0",
        },
      })
    ).toBeUndefined();
    // The default AsyncAPI format unwraps in every registered spelling.
    expect(
      payloadSchema({
        payload: {
          schema: { type: "object" },
          schemaFormat: "application/vnd.aai.asyncapi+yaml;version=3.0.0",
        },
      })
    ).toStrictEqual({ type: "object" });
    expect(payloadSchema({})).toBeUndefined();
  });

  it("lowers channel parameters into the shared parameter shape", () => {
    const parameters = channelParameters(channel, ASYNC_SPEC_3);
    expect(parameters).toStrictEqual([
      {
        description: "Deployment region",
        in: "channel",
        name: "region",
        required: true,
        schema: { default: "eu", enum: ["eu", "us"], type: "string" },
      },
    ]);
    expect(channelParameters(undefined, ASYNC_SPEC_3)).toStrictEqual([]);
    // Component refs resolve; malformed entries drop.
    const viaRef = channelParameters(
      {
        parameters: { p: { $ref: "#/components/parameters/p" }, q: null },
      } as never,
      {
        components: { parameters: { p: { description: "Ref'd" } } },
      } as never
    );
    expect(viaRef).toStrictEqual([
      {
        description: "Ref'd",
        in: "channel",
        name: "p",
        required: true,
        schema: { type: "string" },
      },
    ]);
  });

  it("resolves channel servers, defaulting to all declared", () => {
    const prod = {
      host: "broker.example.com:9092",
      protocol: "kafka",
      security: [{ $ref: "#/components/securitySchemes/sasl" }],
    };
    expect(channelServers(channel, ASYNC_SPEC_3)).toStrictEqual([prod]);
    // No channel-level servers: every server applies.
    expect(
      channelServers(ASYNC_SPEC_3.channels?.ping, ASYNC_SPEC_3)
    ).toStrictEqual([prod]);
    // Unresolvable refs drop; a document with no servers yields none.
    expect(
      channelServers(
        { servers: [{ $ref: "#/servers/missing" }, "junk"] } as never,
        ASYNC_SPEC_3
      )
    ).toStrictEqual([]);
    expect(channelServers(undefined, {} as never)).toStrictEqual([]);
  });

  it("detects the protocol from bindings, then servers, with aliases", () => {
    const servers = channelServers(channel, ASYNC_SPEC_3);
    expect(protocolOf(operation, channel, servers)).toBe("kafka");
    expect(protocolOf({ bindings: { wss: {} } }, channel, servers)).toBe("ws");
    expect(protocolOf({}, {}, servers)).toBe("kafka");
    expect(protocolOf({}, {}, [])).toBeUndefined();
    expect(protocolOf({}, {}, [{ protocol: "" }])).toBeUndefined();
  });

  it("unions server security unless the operation declares its own", () => {
    const servers = [
      { security: [{ $ref: "#/components/securitySchemes/sasl" }] },
      {
        security: [
          { $ref: "#/components/securitySchemes/sasl" },
          { type: "userPassword" },
          "junk",
        ],
      },
    ];
    expect(asyncApiSecurityEntries(undefined, servers as never)).toStrictEqual([
      { $ref: "#/components/securitySchemes/sasl" },
      { type: "userPassword" },
    ]);
    // A declared list wins outright — even an empty one (public operation).
    expect(
      asyncApiSecurityEntries({ security: [] }, servers as never)
    ).toStrictEqual([]);
  });

  it("flattens binding maps, dropping bindingVersion and empty groups", () => {
    expect(
      bindingGroups({
        empty: { bindingVersion: "0.5.0" },
        kafka: { bindingVersion: "0.5.0", topic: "user-signups" },
        malformed: null as never,
      })
    ).toStrictEqual([
      { protocol: "kafka", rows: [{ name: "topic", value: "user-signups" }] },
    ]);
    expect(bindingGroups()).toStrictEqual([]);
  });
});

describe("components/openapi/async-snippets", () => {
  const base: MessageSample = {
    action: "receive",
    address: "user/signedup",
    payload: { id: "u1" },
    server: { host: "broker.example.com:9092", protocol: "kafka" },
  };

  it("picks tools by protocol and filters by configured ids", () => {
    expect(asyncSampleLanguages([], "ws").map((t) => t.id)).toStrictEqual([
      "wscat",
      "js",
    ]);
    expect(asyncSampleLanguages([], "kafka").map((t) => t.id)).toStrictEqual([
      "kcat",
    ]);
    expect(asyncSampleLanguages([], "mqtt").map((t) => t.id)).toStrictEqual([
      "mosquitto",
    ]);
    // Config filters/orders; aliases and duplicates normalize; unknown drops.
    expect(
      asyncSampleLanguages(["node", "wscat", "javascript", "curl"], "ws").map(
        (t) => t.id
      )
    ).toStrictEqual(["js", "wscat"]);
    // Unsupported or missing protocols render no client at all.
    expect(asyncSampleLanguages([], "amqp")).toStrictEqual([]);
    expect(asyncSampleLanguages([])).toStrictEqual([]);
    expect(asyncSampleLanguages(["kcat"], "ws")).toStrictEqual([]);
    // Ids match case-insensitively, like the OpenAPI `codeSamples` path (the
    // docs spell the tools `WebSocket`/`mosquitto_pub`).
    expect(
      asyncSampleLanguages(["WebSocket"], "ws").map((t) => t.id)
    ).toStrictEqual(["js"]);
    expect(
      asyncSampleLanguages(["Mosquitto_Pub"], "mqtt").map((t) => t.id)
    ).toStrictEqual(["mosquitto"]);
  });

  it("builds kcat producer/consumer samples", () => {
    const [kcat] = asyncSampleLanguages([], "kafka");
    expect(kcat?.build(base)).toBe(
      `echo '{"id":"u1"}' | kcat -b 'broker.example.com:9092' -t 'user/signedup' -P`
    );
    expect(kcat?.build({ ...base, action: "send" })).toBe(
      "kcat -b 'broker.example.com:9092' -t 'user/signedup' -C"
    );
    // No server falls back to a local broker; no payload to `{}`.
    expect(
      kcat?.build({ action: "receive", address: "t", payload: undefined })
    ).toBe("echo '{}' | kcat -b 'localhost:9092' -t 't' -P");
  });

  it("builds mosquitto pub/sub samples, splitting host and port", () => {
    const [mosquitto] = asyncSampleLanguages([], "mqtt");
    const sample: MessageSample = {
      ...base,
      server: { host: "broker.example.com:1883", protocol: "mqtt" },
    };
    expect(mosquitto?.build(sample)).toBe(
      `mosquitto_pub -h 'broker.example.com' -p 1883 -t 'user/signedup' -m '{"id":"u1"}'`
    );
    expect(
      mosquitto?.build({
        ...sample,
        action: "send",
        server: { host: "broker.example.com" },
      })
    ).toBe("mosquitto_sub -h 'broker.example.com' -t 'user/signedup' -v");
  });

  it("builds wscat and WebSocket samples from the channel address", () => {
    const [wscat, js] = asyncSampleLanguages([], "ws");
    const sample: MessageSample = {
      action: "receive",
      address: "chat/{roomId}",
      payload: { text: "hi" },
      server: { host: "example.com", pathname: "/v1", protocol: "wss" },
    };
    expect(wscat?.build(sample)).toBe(
      `wscat -c 'wss://example.com/v1/chat/{roomId}'\n> {"text":"hi"}`
    );
    expect(wscat?.build({ ...sample, action: "send" })).toBe(
      "# Prints each message as it arrives\nwscat -c 'wss://example.com/v1/chat/{roomId}'"
    );
    const send = js?.build(sample);
    expect(send).toContain(
      'const socket = new WebSocket("wss://example.com/v1/chat/{roomId}");'
    );
    expect(send).toContain("socket.send(JSON.stringify(");
    const listen = js?.build({
      ...sample,
      action: "send",
      server: { host: "example.com", protocol: "ws" },
    });
    expect(listen).toContain('new WebSocket("ws://example.com/chat/{roomId}")');
    expect(listen).toContain("JSON.parse(event.data)");
    // No server at all: a wss placeholder host.
    expect(wscat?.build({ action: "send", address: "" })).toBe(
      "# Prints each message as it arrives\nwscat -c 'wss://localhost'"
    );
  });
});

describe("security.resolveAsyncApiSecurity", () => {
  const schemes = {
    oauth: { type: "oauth2" },
    sasl: { description: "SCRAM auth", type: "scramSha256" },
  };

  it("turns each entry into its own one-scheme alternative", () => {
    const security = resolveAsyncApiSecurity(
      [
        { $ref: "#/components/securitySchemes/sasl" },
        { scopes: ["read:users", 42], type: "oauth2" },
        { $ref: "#/components/securitySchemes/missing" },
        { $ref: "http://example.com/external#/x" },
        { scopes: "not-an-array" },
        null as never,
      ],
      schemes
    );
    expect(security.optional).toBe(false);
    expect(security.alternatives).toHaveLength(5);
    expect(security.alternatives[0]).toStrictEqual([
      { key: "sasl", scheme: schemes.sasl, scopes: [] },
    ]);
    // Inline scheme: itself, with its string scopes.
    expect(security.alternatives[1]?.[0]).toMatchObject({
      key: "oauth2",
      scopes: ["read:users"],
    });
    // Unknown ref kept with no scheme, so the requirement still renders.
    expect(security.alternatives[2]).toStrictEqual([
      { key: "missing", scheme: undefined, scopes: [] },
    ]);
    // A non-components ref cannot resolve and is not inline.
    expect(security.alternatives[3]?.[0]?.scheme).toBeUndefined();
    // An inline scheme without a type still renders under a generic key.
    expect(security.alternatives[4]?.[0]?.key).toBe("security");
  });

  it("labels AsyncAPI scheme types and carriers", () => {
    const expected: [string, string][] = [
      ["userPassword", "Username & password"],
      ["X509", "X.509 certificate"],
      ["symmetricEncryption", "Symmetric encryption"],
      ["asymmetricEncryption", "Asymmetric encryption"],
      ["plain", "SASL/PLAIN"],
      ["scramSha256", "SASL/SCRAM-SHA-256"],
      ["scramSha512", "SASL/SCRAM-SHA-512"],
      ["gssapi", "SASL/GSSAPI"],
      ["httpApiKey", "API key"],
    ];
    for (const [type, labelText] of expected) {
      expect(schemeLabel({ key: "k", scheme: { type }, scopes: [] })).toBe(
        labelText
      );
    }
    expect(
      schemeCarrier({
        key: "k",
        scheme: { in: "query", name: "token", type: "httpApiKey" },
        scopes: [],
      })
    ).toStrictEqual({ in: "query", name: "token" });
  });
});

describe("render-mdx for AsyncAPI operations", () => {
  const spec = {
    codeSamples: [],
    description: "Events API.",
    document: ASYNC_SPEC_3,
    expandSchemas: false,
    kind: "asyncapi" as const,
    label: "Events",
    operations: {},
    playground: { enabled: false, proxy: false },
    route: "/events",
    slug: "events",
    tags: [],
    title: "Events",
    version: "2.0.0",
  } satisfies ApiSpecData;

  it("titles pages by action + channel and describes the operation", () => {
    const operation: ApiOperationRef = {
      channelId: "userSignedup",
      deprecated: false,
      description: "",
      key: "pingop",
      method: "send",
      operationId: "pingOp",
      path: "user/signedup",
      route: "/events/ping/pingop",
      summary: "",
      tag: "ping",
      tagSlug: "ping",
    };
    const page = operationMdx(spec, operation);
    expect(page.data.title).toBe("SEND user/signedup");
    expect(page.data.seo).toStrictEqual({
      description:
        "Reference for the send operation on user/signedup in the Events API.",
    });
    expect(page.data.sidebar).toStrictEqual({
      badge: "SEND",
      label: "user/signedup",
    });
    expect(page.data.search).toStrictEqual({ tags: ["ping", "SEND"] });
    expect(page.body).toBe('<Operation source="events" id="pingop" />');
  });
});

describe("source.openApiSource with AsyncAPI references", () => {
  it("emits one entry per operation plus an overview, tagged with the kind", async () => {
    const dir = await tempSpec(ASYNC_SPEC_3);
    const source = openApiSource([asyncReference], ctx(dir));
    const { entries, diagnostics, folderMeta } = await source.load();
    expect(diagnostics).toStrictEqual([]);
    // 2 operations + 1 overview index.
    expect(entries.map((entry) => entry.ref)).toStrictEqual([
      "events/ping/pingop.mdx",
      "events/users/publishusersignedup.mdx",
      "events/index.mdx",
    ]);
    expect(folderMeta).toStrictEqual({
      "events/ping": { title: "ping" },
      "events/users": { title: "Users" },
    });
    const data = source.openApiData();
    expect(data.events?.kind).toBe("asyncapi");
    expect(data.events?.title).toBe("Events");
    expect(data.events?.version).toBe("2.0.0");
    expect(data.events?.operations.publishusersignedup?.route).toBe(
      "/events/users/publishusersignedup"
    );
    await rm(dir, { force: true, recursive: true });
  });

  it("lowers per-source indexing controls into frontmatter", async () => {
    const dir = await tempSpec(ASYNC_SPEC_3);
    const source = openApiSource(
      [
        {
          ...asyncReference,
          includeInLlms: false,
          includeInSearch: false,
          noindex: true,
        },
      ],
      ctx(dir)
    );
    const { entries } = await source.load();
    for (const entry of entries) {
      expect(entry.data.ai).toStrictEqual({ exclude: true });
      expect(entry.data.search).toMatchObject({ exclude: true });
      expect(entry.data.seo).toMatchObject({ noindex: true });
    }
    await rm(dir, { force: true, recursive: true });
  });

  it("surfaces converter warnings and skipped operations as diagnostics", async () => {
    const dir = await tempSpec(ASYNC_SPEC_2);
    const { diagnostics } = await openApiSource(
      [asyncReference],
      ctx(dir)
    ).load();
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "BLUME_ASYNCAPI_SPEC_WARNING" &&
          diagnostic.message.startsWith("Converting spec.json")
      )
    ).toBe(true);
    await rm(dir, { force: true, recursive: true });
  });

  it("warns when a spec declares no operations", async () => {
    const dir = await tempSpec({
      asyncapi: "3.0.0",
      info: { title: "Empty", version: "1" },
    });
    const { diagnostics, entries } = await openApiSource(
      [asyncReference],
      ctx(dir)
    ).load();
    expect(entries).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_ASYNCAPI_EMPTY");
    expect(diagnostics[0]?.suggestion).toContain("`channels` and `operations`");
    await rm(dir, { force: true, recursive: true });
  });

  it("reports skipped operations under the AsyncAPI code", async () => {
    const dir = await tempSpec({
      asyncapi: "3.0.0",
      channels: { c: { address: "c" } },
      info: { title: "T", version: "1" },
      operations: {
        good: { action: "send", channel: { $ref: "#/channels/c" } },
        headless: { channel: { $ref: "#/channels/c" } },
      },
    });
    const { diagnostics } = await openApiSource(
      [asyncReference],
      ctx(dir)
    ).load();
    expect(diagnostics[0]?.code).toBe("BLUME_ASYNCAPI_SKIPPED_OPERATION");
    expect(diagnostics[0]?.message).toContain('In AsyncAPI spec "spec.json"');
    await rm(dir, { force: true, recursive: true });
  });

  it("fails loudly on a non-AsyncAPI document with a kind-specific hint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-asyncapi-"));
    await writeFile(join(dir, "spec.json"), JSON.stringify({ not: "a spec" }));
    const { diagnostics } = await openApiSource(
      [asyncReference],
      ctx(dir)
    ).load();
    expect(diagnostics[0]?.code).toBe("BLUME_ASYNCAPI_UNAVAILABLE");
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0]?.message).toContain(
      "is not a valid AsyncAPI document"
    );
    expect(diagnostics[0]?.suggestion).toContain("an AsyncAPI document");
    await rm(dir, { force: true, recursive: true });
  });

  it("loads OpenAPI and AsyncAPI references side by side", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-asyncapi-"));
    await writeFile(join(dir, "events.json"), JSON.stringify(ASYNC_SPEC_3));
    await writeFile(
      join(dir, "api.json"),
      JSON.stringify({
        info: { title: "API", version: "1" },
        openapi: "3.1.0",
        paths: {
          "/ping": { get: { responses: { "200": { description: "ok" } } } },
        },
      })
    );
    const source = openApiSource(
      [
        {
          ...asyncReference,
          spec: "events.json",
        },
        {
          ...asyncReference,
          kind: "openapi" as const,
          label: "API",
          route: "/reference",
          slug: "reference",
          spec: "api.json",
        },
      ],
      ctx(dir)
    );
    const { entries } = await source.load();
    const data = source.openApiData();
    expect(data.events?.kind).toBe("asyncapi");
    expect(data.reference?.kind).toBe("openapi");
    expect(entries.some((e) => e.ref.startsWith("events/"))).toBe(true);
    expect(entries.some((e) => e.ref.startsWith("reference/"))).toBe(true);
    await rm(dir, { force: true, recursive: true });
  });
});
