import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import { readRuntimeModule } from "../src/astro/runtime-modules.ts";
import { mountBase } from "../src/components/islands/base-path.ts";
import { packageRoot } from "../src/core/package-root.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { OpenApiData } from "../src/openapi/model.ts";

// The playground's Send button targets `spec.playground.proxy` (with the
// deployment base layered on at render time), while the built-in endpoint is
// injected into the Astro config by pattern. The two must name the same URL
// under every combination of `basePath` and `deployment.base`, or each send
// falls through to the content catch-all and 404s.

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const INJECTED_PROXY =
  /"entrypoint":"[^"]*api-proxy\.ts","pattern":"(?<pattern>[^"]+)"/u;

/** Generate a project with the built-in proxy on and the given site options. */
const generateProxy = async (
  siteOptions: string
): Promise<{
  astroConfig: string;
  injected: string;
  proxy: string | false;
}> => {
  const root = await mkdtemp(join(tmpdir(), "blume-proxy-route-"));
  dirs.push(root);
  await writeFile(
    join(root, "blume.config.ts"),
    `export default {
  ${siteOptions}
  reference: [{ kind: "openapi", options: { playground: { proxy: true }, spec: "./openapi.json" }, requiredSecrets: [], runtimeDeps: [] }],
};
`
  );
  await Bun.write(join(root, "docs/index.md"), "# Home\n");
  await writeFile(
    join(root, "openapi.json"),
    JSON.stringify({
      info: { title: "API", version: "1" },
      openapi: "3.0.0",
      paths: { "/ping": { get: { responses: { "200": {} } } } },
      servers: [{ url: "https://api.example.com" }],
    })
  );
  const project = await scanProject(root);
  await generateRuntime(project);
  const astroConfig = await readFile(
    join(project.context.outDir, "astro.config.mjs"),
    "utf-8"
  );
  const specs: OpenApiData = JSON.parse(
    readRuntimeModule("blume:openapi") ?? "{}"
  );
  const [spec] = Object.values(specs);
  return {
    astroConfig,
    injected: INJECTED_PROXY.exec(astroConfig)?.groups?.pattern ?? "",
    proxy: spec?.playground.proxy ?? false,
  };
};

describe("built-in playground proxy route", () => {
  it("mounts the endpoint under basePath, where the playground sends", async () => {
    const { injected, proxy } = await generateProxy('basePath: "/docs",');
    expect(injected).toBe("/docs/_api-proxy");
    expect(proxy).toBe(injected);
  }, 30_000);

  it("leaves the deployment base to Astro on both sides", async () => {
    const { astroConfig, injected, proxy } = await generateProxy(
      'deployment: { base: "/sub" },'
    );
    // Astro serves every route, the injected endpoint included, under its
    // `base`; the spec data stays base-less like every internal route in it.
    expect(astroConfig).toContain('base: "/sub",');
    expect(injected).toBe("/_api-proxy");
    expect(proxy).toBe("/_api-proxy");
    // The playground layers the base on at render time (`withMountedBase`),
    // which lands on the served endpoint and leaves an external proxy URL
    // alone.
    expect(mountBase("/sub", proxy || "")).toBe("/sub/_api-proxy");
    expect(mountBase("/sub", "https://proxy.example/cors")).toBe(
      "https://proxy.example/cors"
    );
  }, 30_000);

  it("renders the proxy URL through withMountedBase in the playground", () => {
    const source = readFileSync(
      join(packageRoot(), "src/components/openapi/Playground.astro"),
      "utf-8"
    );
    expect(source).toContain(
      'import { withMountedBase } from "../islands/base-path.ts";'
    );
    expect(source).toContain(
      "const proxyUrl = proxy ? withMountedBase(proxy) : undefined;"
    );
    expect(source).toContain("data-proxy={proxyUrl}");
  });
});
