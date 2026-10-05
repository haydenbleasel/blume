import { describe, expect, it } from "bun:test";

import { downlevelComponents } from "../src/ai/component-markdown.ts";
import { openapiComponentSerializers } from "../src/ai/openapi-components.ts";
import type { ApiOperationRef, ApiSpecData } from "../src/openapi/model.ts";

const operation = (
  overrides: Partial<ApiOperationRef> & Pick<ApiOperationRef, "key">
): ApiOperationRef => ({
  deprecated: false,
  description: "",
  method: "get",
  path: "/pets",
  route: "/reference/pets/list-pets",
  summary: "",
  tag: "Pets",
  tagSlug: "pets",
  ...overrides,
});

const spec = (
  operations: ApiOperationRef[],
  overrides: Partial<ApiSpecData> = {}
): ApiSpecData => ({
  codeSamples: [],
  description: "",
  // SAFETY: the serializers read the document only through `specAddresses`,
  // which tolerates a document declaring no servers; the tests that need
  // servers override it.
  document: {} as ApiSpecData["document"],
  expandSchemas: false,
  kind: "openapi",
  label: "API",
  operations: Object.fromEntries(operations.map((entry) => [entry.key, entry])),
  playground: { enabled: false, proxy: false },
  route: "/reference",
  slug: "reference",
  tags: [{ description: "", name: "Pets", slug: "pets" }],
  title: "Pet API",
  version: "1.0.0",
  ...overrides,
});

const serializers = openapiComponentSerializers;

describe("openapi component serializers", () => {
  it("gives an operation page its method and path", () => {
    const data = {
      reference: spec([operation({ key: "list-pets", summary: "List pets" })]),
    };
    const source =
      'Lists every pet.\n\n<Operation source="reference" id="list-pets" />\n';
    expect(downlevelComponents(source, serializers(data))).toBe(
      "Lists every pet.\n\n`GET /pets`\n"
    );
  });

  it("marks a deprecated operation, which the description alone does not", () => {
    const data = {
      reference: spec([
        operation({
          deprecated: true,
          key: "old",
          method: "post",
          path: "/v1/pets",
        }),
      ]),
    };
    expect(
      downlevelComponents(
        '<Operation source="reference" id="old" />\n',
        serializers(data)
      )
    ).toBe("`POST /v1/pets`\n\n**Deprecated.**\n");
  });

  it("tells an agent a webhook is sent to it, not served", () => {
    const data = {
      reference: spec([
        operation({
          deprecated: true,
          key: "new-pet",
          method: "post",
          path: "newPet",
          webhook: true,
        }),
      ]),
    };
    expect(
      downlevelComponents(
        '<Operation source="reference" id="new-pet" />\n',
        serializers(data)
      )
    ).toBe(
      "`POST newPet`\n\n**Webhook.** The API sends this request to your endpoint.\n\n**Deprecated.**\n"
    );
  });

  it("carries the spec's own x-codeSamples, labeled as their tabs are", () => {
    const data = {
      reference: spec([operation({ key: "list-pets" })], {
        document: {
          info: { title: "Pet API", version: "1.0.0" },
          openapi: "3.1.0",
          paths: {
            "/pets": {
              get: {
                "x-codeSamples": [
                  {
                    label: "SDK *beta*",
                    lang: "typescript",
                    source: "const pets = await client.pets.list();\n",
                  },
                  { lang: "bash", source: "pets list --limit 10" },
                  { lang: "go", source: { $ref: "./list-pets.go" } },
                ],
              },
            },
          },
        },
      }),
    };
    expect(
      downlevelComponents(
        '<Operation source="reference" id="list-pets" />\n',
        serializers(data)
      )
    ).toBe(
      [
        "`GET /pets`",
        String.raw`**SDK \*beta\***`,
        "```ts\nconst pets = await client.pets.list();\n```",
        "**Shell**",
        "```bash\npets list --limit 10\n```\n",
      ].join("\n\n")
    );
  });

  it("names an AsyncAPI operation by its action and channel, as the page does", () => {
    const data = {
      events: spec(
        [
          operation({
            channelId: "signup",
            key: "on-signup",
            method: "send",
            path: "user/signup",
            route: "/events/user/on-signup",
            tag: "User",
            tagSlug: "user",
          }),
        ],
        { kind: "asyncapi", slug: "events" }
      ),
    };
    expect(
      downlevelComponents(
        '<Operation source="events" id="on-signup" />\n',
        serializers(data)
      )
    ).toBe("`SEND user/signup`\n");
  });

  it("names GraphQL members the way the schema declares them, not as HTTP verbs", () => {
    // The page shows a kind badge beside the name; `OBJECT Pet` in text
    // reads as an endpoint that does not exist, `type Pet` as the SDL it is.
    const members: [string, ApiOperationRef["method"], string][] = [
      ["query", "query", "query pets"],
      ["mutation", "mutation", "mutation addPet"],
      ["subscription", "subscription", "subscription onPet"],
      ["object", "object", "type Pet"],
      ["input", "input", "input PetInput"],
      ["enum", "enum", "enum Status"],
      ["interface", "interface", "interface Node"],
      ["union", "union", "union SearchResult"],
      ["scalar", "scalar", "scalar DateTime"],
    ];
    const data = {
      graph: spec(
        members.map(([key, method, signature]) =>
          operation({
            key,
            method,
            path: signature.split(" ")[1] ?? "",
            route: `/graph/${key}`,
            tag: key,
            tagSlug: key,
          })
        ),
        { kind: "graphql", slug: "graph" }
      ),
    };
    for (const [key, , signature] of members) {
      expect(
        downlevelComponents(
          `<Operation source="graph" id="${key}" />\n`,
          serializers(data)
        )
      ).toBe(`\`${signature}\`\n`);
    }
  });

  it("keeps a backtick in a path or address inside its code span", () => {
    // A backtick in the value would close a fixed single-backtick span early,
    // so the span's delimiter outlengths any backtick run in the value.
    const data = {
      reference: spec(
        [
          operation({
            key: "odd",
            path: "/odd/`tick`",
            route: "/reference/pets/odd",
            summary: "Odd",
          }),
          operation({
            key: "edge",
            path: "/edge/``",
            route: "/reference/pets/edge",
          }),
        ],
        {
          // SAFETY: `specAddresses` reads only `servers` off an OpenAPI
          // document.
          document: {
            servers: [{ url: "https://api.example.com/`v1`" }],
          } as ApiSpecData["document"],
        }
      ),
    };
    expect(
      downlevelComponents(
        '<Operation source="reference" id="odd" />\n',
        serializers(data)
      )
    ).toBe("`` GET /odd/`tick` ``\n");
    expect(
      downlevelComponents(
        '<Operation source="reference" id="edge" />\n',
        serializers(data)
      )
    ).toBe("``` GET /edge/`` ```\n");
    expect(
      downlevelComponents(
        '<ApiTagOperations source="reference" tag="pets" />\n',
        serializers(data)
      )
    ).toBe(
      "- [`` GET /odd/`tick` ``](/reference/pets/odd) — Odd.\n- [``` GET /edge/`` ```](/reference/pets/edge)\n"
    );
    expect(
      downlevelComponents(
        '<ApiOverview source="reference" />\n',
        serializers(data)
      )
    ).toBe("Version 1.0.0\n\nBase URL: `` https://api.example.com/`v1` ``\n");
  });

  it("lists a tag's operations as links, with their summaries", () => {
    const data = {
      reference: spec([
        operation({ key: "list-pets", summary: "List pets" }),
        operation({
          key: "add-pet",
          method: "post",
          route: "/reference/pets/add-pet",
          summary: "Add a pet",
        }),
        operation({ key: "elsewhere", tag: "Owners", tagSlug: "owners" }),
      ]),
    };
    expect(
      downlevelComponents(
        '<ApiTagOperations source="reference" tag="pets" />\n',
        serializers(data)
      )
    ).toBe(
      "- [`GET /pets`](/reference/pets/list-pets) — List pets.\n- [`POST /pets`](/reference/pets/add-pet) — Add a pet.\n"
    );
  });

  it("keeps a spec-authored summary as text, not as Markdown markup", () => {
    // The summary is the spec author's, not the docs author's: `<user>`
    // would be inline HTML and `*only*` emphasis to any Markdown reader.
    const data = {
      reference: spec([
        operation({
          deprecated: true,
          key: "get-user",
          path: "/users/{id}",
          route: "/reference/pets/get user (v1)",
          summary: "  Fetch <user>\n  by id, *only* for [admins]_ ",
        }),
      ]),
    };
    expect(
      downlevelComponents(
        '<ApiTagOperations source="reference" tag="pets" />\n',
        serializers(data)
      )
    ).toBe(
      [
        "- [`GET /users/{id}`](</reference/pets/get user (v1)>) — Fetch ",
        "\\<user\\> by id, \\*only\\* for \\[admins\\]\\_. Deprecated.\n",
      ].join("")
    );
  });

  it("gives the overview its version and base URLs, as the page shows them", () => {
    const data = {
      reference: spec([operation({ key: "a" })], {
        // SAFETY: `specAddresses` reads only `servers` off an OpenAPI document.
        document: {
          servers: [
            { url: "https://api.example.com/v2" },
            { description: "no url" },
            { url: "https://sandbox.example.com" },
          ],
        } as ApiSpecData["document"],
      }),
    };
    expect(
      downlevelComponents(
        'Intro.\n\n<ApiOverview source="reference" />\n\n## Pets\n',
        serializers(data)
      )
    ).toBe(
      "Intro.\n\nVersion 1.0.0\n\nBase URL: `https://api.example.com/v2`, `https://sandbox.example.com`\n\n## Pets\n"
    );
  });

  it("tolerates a document whose servers are not the array the spec promises", () => {
    const data = {
      reference: spec([], {
        // A hand-written spec can put an object where `servers` is typed as
        // an array; parsed from text, as a real spec is, so the type cannot
        // rule it out and the overview must degrade rather than throw.
        document: JSON.parse('{ "servers": { "url": "x" } }'),
        version: "",
      }),
    };
    const source = '<ApiOverview source="reference" />\n';
    // Nothing to show: no version and no address, so the component renders
    // nothing and the serializer declines.
    expect(downlevelComponents(source, serializers(data))).toBe(source);
  });

  it("lists AsyncAPI servers by protocol, host and path", () => {
    const data = {
      events: spec([], {
        // SAFETY: `specAddresses` reads only `servers` off an AsyncAPI
        // document.
        document: {
          servers: {
            bare: { host: "bare.example.com" },
            dev: { host: "localhost:1883", protocol: "mqtt" },
            hostless: { protocol: "ws" },
            prod: {
              host: "events.example.com",
              pathname: "/v1",
              protocol: "wss",
            },
          },
        } as ApiSpecData["document"],
        kind: "asyncapi",
        slug: "events",
        version: "2.0.0",
      }),
    };
    expect(
      downlevelComponents(
        '<ApiOverview source="events" />\n',
        serializers(data)
      )
    ).toBe(
      "Version 2.0.0\n\nServers: `bare.example.com`, `mqtt://localhost:1883`, `wss://events.example.com/v1`\n"
    );
  });

  it("names the GraphQL endpoint, and only the version when none is configured", () => {
    const withEndpoint = {
      graph: spec([], {
        endpoint: "https://api.example.com/graphql",
        kind: "graphql",
        slug: "graph",
      }),
    };
    expect(
      downlevelComponents(
        '<ApiOverview source="graph" />\n',
        serializers(withEndpoint)
      )
    ).toBe("Version 1.0.0\n\nEndpoint: `https://api.example.com/graphql`\n");
    const without = { graph: spec([], { kind: "graphql", slug: "graph" }) };
    expect(
      downlevelComponents(
        '<ApiOverview source="graph" />\n',
        serializers(without)
      )
    ).toBe("Version 1.0.0\n");
  });

  it("declines rather than emitting a page that lost its endpoint", () => {
    // An id or source the spec does not carry means the build and the spec
    // disagree. Leaving the JSX visible is Blume's own fallback and the honest
    // outcome; the alternative is a page silently missing its endpoint.
    const data = { reference: spec([operation({ key: "list-pets" })]) };
    for (const source of [
      '<Operation source="reference" id="gone" />\n',
      '<Operation source="reference" />\n',
      '<Operation source="other" id="list-pets" />\n',
      '<ApiTagOperations source="reference" tag="nothing" />\n',
      '<ApiTagOperations source="other" tag="pets" />\n',
      '<ApiTagOperations source="reference" />\n',
      '<ApiOverview source="other" />\n',
    ]) {
      expect(downlevelComponents(source, serializers(data))).toBe(source);
    }
  });

  it("declines a name inherited from Object.prototype rather than throwing", () => {
    // `specs["toString"]` and `operations["toString"]` find the inherited
    // function, which is truthy and carries none of the fields read next.
    const data = { reference: spec([operation({ key: "list-pets" })]) };
    for (const source of [
      '<Operation source="toString" id="list-pets" />\n',
      '<Operation source="reference" id="toString" />\n',
      '<ApiTagOperations source="constructor" tag="pets" />\n',
      '<ApiOverview source="valueOf" />\n',
    ]) {
      expect(downlevelComponents(source, serializers(data))).toBe(source);
    }
  });

  it("declines every component when the project has no API reference", () => {
    const bare = serializers({});
    const source = '<Operation source="reference" id="list-pets" />\n';
    expect(downlevelComponents(source, bare)).toBe(source);
  });
});
