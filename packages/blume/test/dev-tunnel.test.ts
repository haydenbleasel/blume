import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import { cloudflareTunnelOutputPlugin } from "../src/astro/tunnel-output.ts";
import { scanProject } from "../src/core/project-graph.ts";

const PKG_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const CLI = join(PKG_ROOT, "bin", "blume.mjs");
const DEPLOY_ADAPTERS = join(PKG_ROOT, "src", "deploy", "adapters", "index.ts");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const runBun = async (args: string[], cwd: string) => {
  const process = Bun.spawn(["bun", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const tempProject = async (
  deployment: "node" | "cloudflare-static" | "cloudflare-server"
) => {
  const root = await mkdtemp(join(tmpdir(), "blume-dev-tunnel-"));
  tempDirs.push(root);
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "index.md"), "# Docs\n");
  const constructor = deployment === "node" ? "node" : "cloudflare";
  const deploymentOptions =
    deployment === "cloudflare-static" ? '({ output: "static" })' : "()";
  await writeFile(
    join(root, "blume.config.ts"),
    `import { ${constructor} } from ${JSON.stringify(DEPLOY_ADAPTERS)};\nexport default { deployment: ${constructor}${deploymentOptions} };\n`
  );
  return root;
};

describe("blume dev tunnel flags", () => {
  it("prints Vite URLs after the tunnel-aware server listen completes", async () => {
    const events: string[] = [];
    const fakeServer = {
      listen: () => {
        events.push("listen");
        return Promise.resolve(fakeServer);
      },
      printUrls: () => events.push("printUrls"),
    };
    const plugin = cloudflareTunnelOutputPlugin();
    plugin.configureServer(fakeServer);

    await fakeServer.listen();
    expect(events).toEqual(["listen", "printUrls"]);
  });

  it("parses tunnel modes and rejects empty or flag-shaped names", async () => {
    const script = `
      const { parseArgs } = await import("citty");
      const { devCommand, resolveTunnelOptions } = await import(${JSON.stringify(join(PKG_ROOT, "src", "cli", "commands", "dev.ts"))});
      const request = (argv) => {
        const args = parseArgs(argv, devCommand.args);
        const result = resolveTunnelOptions(args.tunnel, args["tunnel-name"]);
        return { tunnel: args.tunnel, name: args["tunnel-name"], result };
      };
      console.log(JSON.stringify([
        request([]),
        request(["--tunnel"]),
        request(["--tunnel-name", "docs-share"]),
        request(["--tunnel-name="]),
        request(["--tunnel-name", "--debug"]),
      ]));
    `;
    const result = await runBun(["-e", script], REPO_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([
      { result: { _tag: "ok" } },
      { result: { _tag: "ok", options: { autoStart: true } }, tunnel: true },
      {
        name: "docs-share",
        result: {
          _tag: "ok",
          options: { autoStart: true, name: "docs-share" },
        },
      },
      {
        name: "",
        result: {
          _tag: "invalid-name",
          message:
            "`--tunnel-name` requires a non-empty name, not an option flag.",
        },
      },
      {
        name: "--debug",
        result: {
          _tag: "invalid-name",
          message:
            "`--tunnel-name` requires a non-empty name, not an option flag.",
        },
      },
    ]);
  });

  it("rejects unsupported deployments before Astro starts and releases the dev lock", async () => {
    const outcomes = await Promise.all(
      (["node", "cloudflare-static"] as const).map(async (deployment) => {
        const root = await tempProject(deployment);
        const result = await runBun([CLI, "dev", "--tunnel"], root);
        const lockExists = await Bun.file(
          join(root, ".blume", "dev.lock")
        ).exists();
        return { lockExists, result };
      })
    );
    for (const { lockExists, result } of outcomes) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toContain(
        "requires `deployment: cloudflare()` with server output"
      );
      expect(lockExists).toBe(false);
    }
  });

  it("retains the transient tunnel option when the runtime is regenerated", async () => {
    const root = await tempProject("cloudflare-server");
    const project = await scanProject(root, { mode: "dev" });
    const tunnel = { autoStart: true as const, name: "docs-share" };
    const configFile = join(root, ".blume", "astro.config.mjs");

    await generateRuntime(project, { tunnel });
    expect(await Bun.file(configFile).text()).toContain(
      '"tunnel":{"autoStart":true,"name":"docs-share"}'
    );

    await generateRuntime(project, { tunnel });
    expect(await Bun.file(configFile).text()).toContain(
      '"tunnel":{"autoStart":true,"name":"docs-share"}'
    );
  });
});
