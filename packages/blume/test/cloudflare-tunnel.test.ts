import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import {
  cloudflaredArgs,
  createCloudflareTunnelSpawner,
  resolveQuickTunnelHosts,
  startCloudflareTunnel,
} from "../src/cli/cloudflare-tunnel.ts";
import { scanProject } from "../src/core/project-graph.ts";

const PKG_ROOT = join(import.meta.dir, "..");
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
  it("starts cloudflared against the port Astro actually bound and stops it", async () => {
    const events: string[] = [];
    let onError: ((error: Error) => void) | undefined;
    const tunnelErrors: string[] = [];
    const handle = startCloudflareTunnel(
      4387,
      "127.0.0.1",
      { onError: (error) => tunnelErrors.push(error.message) },
      (args) => {
        events.push(`spawn:${args.join(" ")}`);
        return {
          exitCode: null,
          exited: Promise.resolve(0),
          kill: (signal) => {
            events.push(`kill:${signal}`);
            return true;
          },
          onError: (listener) => {
            onError = listener;
          },
        };
      }
    );

    expect(cloudflaredArgs(4387)).toEqual([
      "cloudflared",
      "tunnel",
      "--url",
      "http://127.0.0.1:4387",
    ]);
    expect(cloudflaredArgs(4387, "::1")[3]).toBe("http://[::1]:4387");
    expect(resolveQuickTunnelHosts()).toEqual({
      devServer: "127.0.0.1",
      origin: "127.0.0.1",
    });
    expect(resolveQuickTunnelHosts("localhost")).toEqual({
      devServer: "127.0.0.1",
      origin: "127.0.0.1",
    });
    expect(resolveQuickTunnelHosts("")).toEqual({
      devServer: true,
      origin: "127.0.0.1",
    });
    expect(resolveQuickTunnelHosts("0.0.0.0")).toEqual({
      devServer: "0.0.0.0",
      origin: "127.0.0.1",
    });
    expect(resolveQuickTunnelHosts("::")).toEqual({
      devServer: "::",
      origin: "::1",
    });
    expect(events).toEqual([
      "spawn:cloudflared tunnel --url http://127.0.0.1:4387",
    ]);
    onError?.(new Error("missing executable"));
    expect(tunnelErrors).toEqual(["missing executable"]);
    const stopped = handle.stop();
    expect(events).toEqual([
      "spawn:cloudflared tunnel --url http://127.0.0.1:4387",
      "kill:SIGTERM",
    ]);
    await stopped;
  });

  it("stops a spawned tunnel child and reports a missing executable", async () => {
    const child = startCloudflareTunnel(
      4387,
      "127.0.0.1",
      { onError: () => {} },
      createCloudflareTunnelSpawner(process.execPath, [
        "-e",
        "setTimeout(() => {}, 5000)",
      ])
    );
    await child.stop();
    expect(await child.exited).not.toBe(0);

    const errors: string[] = [];
    const missing = startCloudflareTunnel(
      4387,
      "127.0.0.1",
      { onError: (error) => errors.push(error.message) },
      createCloudflareTunnelSpawner("blume-cloudflared-missing-test-binary")
    );
    expect(await missing.exited).toBe(127);
    expect(errors).toHaveLength(1);
  });

  it("parses the Quick Tunnel flag", async () => {
    const script = `
      const { parseArgs } = await import("citty");
      const { devCommand } = await import(${JSON.stringify(join(PKG_ROOT, "src", "cli", "commands", "dev.ts"))});
      const request = (argv) => {
        const args = parseArgs(argv, devCommand.args);
        return { tunnel: args.tunnel };
      };
      console.log(JSON.stringify([
        request([]),
        request(["--tunnel"]),
      ]));
    `;
    const result = await runBun(["-e", script], PKG_ROOT);
    if (result.exitCode !== 0) {
      throw new Error(
        `Expected subprocess to exit with code 0, got ${result.exitCode}:\n${result.stderr}`
      );
    }
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([{}, { tunnel: true }]);
  });

  it("retains Quick Tunnel host configuration across deployment types and regeneration", async () => {
    await Promise.all(
      (["node", "cloudflare-static", "cloudflare-server"] as const).map(
        async (deployment) => {
          const root = await tempProject(deployment);
          const project = await scanProject(root, { mode: "dev" });
          const configFile = join(root, ".blume", "astro.config.mjs");

          await generateRuntime(project, { tunnel: true });
          expect(await Bun.file(configFile).text()).toContain(
            "server: { allowedHosts: true }"
          );

          await generateRuntime(project, { tunnel: true });
          expect(await Bun.file(configFile).text()).toContain(
            "server: { allowedHosts: true }"
          );
        }
      )
    );
  });
});
