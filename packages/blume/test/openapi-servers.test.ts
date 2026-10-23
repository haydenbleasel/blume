import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import { webSocketUrl } from "../src/components/openapi/async-snippets.ts";
import { messageModel } from "../src/components/openapi/message-model.ts";
import {
  buildMessage,
  defaultMessageValues,
} from "../src/components/openapi/message.ts";
import {
  effectiveServers,
  operationModel,
} from "../src/components/openapi/operation-model.ts";
import {
  buildRequest,
  defaultValues,
} from "../src/components/openapi/request.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { withServerDefaults } from "../src/openapi/model.ts";

/**
 * Server URLs as the samples, the playground's Send, and the built-in proxy
 * see them: `{variables}` resolved to their declared defaults, and the most
 * specific `servers` list (operation, then path item, then document) in
 * charge of each operation.
 */

describe("withServerDefaults", () => {
  it("fills each variable with its declared default", () => {
    expect(
      withServerDefaults("https://{region}.api.example.com:{port}/{version}", {
        port: { default: 8443 },
        region: { default: "eu", enum: ["eu", "us"] },
        version: { default: "v2" },
      })
    ).toBe("https://eu.api.example.com:8443/v2");
  });

  it("leaves a variable with no usable default templated", () => {
    expect(
      withServerDefaults("https://{region}.{zone}.{toString}.example.com", {
        region: { description: "no default" },
        zone: "not an object",
      })
    ).toBe("https://{region}.{zone}.{toString}.example.com");
    expect(withServerDefaults("https://{region}.example.com", null)).toBe(
      "https://{region}.example.com"
    );
  });
});

describe("effectiveServers", () => {
  const root = [{ url: "https://root.example.com" }];
  const path = [{ url: "https://path.example.com" }];
  const own = [{ url: "https://own.example.com" }];

  it("lets the operation override its path item, and the path item the document", () => {
    expect(effectiveServers(own, path, root)).toBe(own);
    expect(effectiveServers(undefined, path, root)).toBe(path);
    expect(effectiveServers([], [], root)).toBe(root);
    expect(effectiveServers([], [], [])).toStrictEqual([]);
  });
});

describe("templated servers in the request model", () => {
  it("sends to the default-substituted URL", () => {
    const model = operationModel({
      method: "get",
      parameters: [],
      path: "/pets",
      schemas: {},
      security: { alternatives: [], optional: false },
      servers: [
        {
          url: "https://{region}.api.example.com/v1",
          variables: { region: { default: "us" } },
        },
        { url: "/relative" },
        {},
      ],
      strings: EN_UI.reference,
    });
    expect(model.servers).toStrictEqual([
      "https://us.api.example.com/v1",
      "/relative",
      "",
    ]);
    expect(buildRequest(model, defaultValues(model)).url).toBe(
      "https://us.api.example.com/v1/pets"
    );
  });

  it("resolves an AsyncAPI server's host and pathname variables", () => {
    const model = messageModel({
      action: "receive",
      address: "signups",
      messages: [],
      parameters: [],
      protocol: "ws",
      schemas: {},
      servers: [
        {
          host: "{env}.events.example.com",
          pathname: "/{version}",
          protocol: "wss",
          variables: { env: { default: "prod" }, version: { default: "v1" } },
        },
        { protocol: "ws" },
      ],
    });
    expect(model.servers.map((option) => option.label)).toStrictEqual([
      "wss://prod.events.example.com/v1",
      "ws://",
    ]);
    const sample = buildMessage(model, defaultMessageValues(model));
    expect(webSocketUrl(sample)).toBe(
      "wss://prod.events.example.com/v1/signups"
    );
  });
});

describe("the built-in proxy's allowlist", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("allows templated, path-level, and operation-level servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-proxy-servers-"));
    dirs.push(root);
    await writeFile(
      join(root, "blume.config.ts"),
      `export default {
  reference: [{ kind: "openapi", options: { playground: { proxy: true }, spec: "./openapi.json" }, requiredSecrets: [], runtimeDeps: [] }],
};
`
    );
    await Bun.write(join(root, "docs/index.md"), "# Home\n");
    await writeFile(
      join(root, "openapi.json"),
      JSON.stringify({
        info: { title: "API", version: "1" },
        openapi: "3.1.0",
        paths: {
          "/broken": null,
          "/ping": {
            get: {
              responses: { "200": { description: "ok" } },
              servers: [{ url: "https://own.example.com" }],
            },
            servers: [{ url: "https://path.example.com" }],
          },
        },
        servers: [
          {
            url: "https://{region}.api.example.com",
            variables: { region: { default: "eu" } },
          },
          { url: "https://{undefaulted}.api.example.com" },
        ],
      })
    );
    const project = await scanProject(root);
    const { warnings } = await generateRuntime(project);
    const endpoint = await readFile(
      join(project.context.outDir, "src/blume-openapi/api-proxy.ts"),
      "utf-8"
    );
    expect(endpoint).toContain(
      'createPlaygroundProxyHandler(["https://eu.api.example.com","https://own.example.com","https://path.example.com"])'
    );
    expect(
      warnings.filter((warning) => warning.includes("playground.proxy"))
    ).toStrictEqual([]);
  }, 30_000);
});
