import { afterAll, expect, it } from "bun:test";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";

import { dirname, join } from "pathe";

import { packageRoot } from "../src/core/package-root.ts";

const PACKAGE_ROOT = packageRoot();
const CLI = join(PACKAGE_ROOT, "bin", "blume.mjs");
const roots: string[] = [];

const writeProject = async (files: Record<string, string>): Promise<string> => {
  // Keep Blume's source files on one realpath so Astro's compiler metadata uses
  // the same module identities throughout the fixture build.
  const root = await mkdtemp(join(PACKAGE_ROOT, "blume-integrations-"));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
    })
  );
  // Generated configs resolve bare `blume/*` imports from the fixture root.
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(PACKAGE_ROOT, join(root, "node_modules/blume"), "junction");
  return root;
};

const integrationPackage = `
import { appendFileSync } from "node:fs";

export default ({ label, marker }) => ({
  name: "shared-probe",
  hooks: {
    "astro:config:setup": () => appendFileSync(marker, "config:" + label + "\\n"),
    "astro:build:start": () => appendFileSync(marker, "build:" + label + "\\n"),
    "astro:server:setup": () => appendFileSync(marker, "server:" + label + "\\n"),
  },
});
`;

const configSource = (labels: string[]): string => `
import probe from "site-integration";

const marker = new URL("./integration-markers.log", import.meta.url);
export default {
  integrations: ${JSON.stringify(labels)}.map((label) => probe({ label, marker })),
};
`;

const fixtureFiles = (labels: string[]): Record<string, string> => ({
  "blume.config.ts": configSource(labels),
  "docs/index.md": "# Home\n",
  "node_modules/site-integration/index.mjs": integrationPackage,
  "node_modules/site-integration/package.json": JSON.stringify({
    exports: "./index.mjs",
    name: "site-integration",
    type: "module",
    version: "1.0.0",
  }),
});

const markerLines = async (root: string): Promise<string[]> => {
  try {
    const contents = await readFile(
      join(root, "integration-markers.log"),
      "utf-8"
    );
    return contents.split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const expectPair = (lines: string[], event: string, labels: string[]): void => {
  const matching = lines.filter((line) => line.startsWith(`${event}:`));
  expect(matching.slice(-labels.length)).toEqual(
    labels.map((label) => `${event}:${label}`)
  );
};

const waitUntil = (
  predicate: () => boolean | Promise<boolean>,
  timeoutMessage: string,
  timeout = 30_000
): Promise<void> => {
  const expiresAt = Date.now() + timeout;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= expiresAt) {
      throw new Error(timeoutMessage);
    }
    await Bun.sleep(50);
    return poll();
  };
  return poll();
};

const waitForLine = (
  root: string,
  expected: string,
  timeout = 30_000
): Promise<void> =>
  waitUntil(
    async () => {
      const lines = await markerLines(root);
      return lines.includes(expected);
    },
    `Timed out waiting for integration marker: ${expected}`,
    timeout
  );

const generatedConfigHash = async (root: string): Promise<string | null> => {
  const config = await readFile(join(root, ".blume/astro.config.mjs"), "utf-8");
  return (
    config.match(/Blume config source SHA-256: (?<hash>[a-f0-9]{64})/u)?.groups
      ?.hash ?? null
  );
};

const waitForConfigHashChange = (
  root: string,
  previous: string,
  timeout = 30_000
): Promise<void> =>
  waitUntil(
    async () => {
      const hash = await generatedConfigHash(root);
      return hash !== previous;
    },
    "Timed out waiting for generated config hash to change.",
    timeout
  );

const waitForMarkerCount = (
  root: string,
  minimum: number,
  timeout = 30_000
): Promise<void> =>
  waitUntil(
    async () => {
      const lines = await markerLines(root);
      return lines.length >= minimum;
    },
    `Timed out waiting for ${minimum} integration markers.`,
    timeout
  );

const availablePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : null;
  const closed = once(server, "close");
  server.close();
  await closed;
  if (port === null) {
    throw new Error("Could not allocate a dev-server port.");
  }
  return port;
};

const waitForDevServer = (port: number, timeout = 30_000): Promise<void> =>
  waitUntil(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        return true;
      } catch {
        return false;
      }
    },
    `Timed out waiting for dev server on port ${port}.`,
    timeout
  );

const startDev = async (root: string) => {
  const port = await availablePort();
  const proc = Bun.spawn(
    ["bun", CLI, "dev", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const output = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { output, port, proc };
};

const runCli = async (
  root: string,
  args: string[]
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
};

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

it("runs configured integrations in order for build and dev, regenerates once on edit, and applies edits after process restart", async () => {
  const initial = ["first", "second"];
  const updated = ["updated-first", "updated-second"];
  const root = await writeProject(fixtureFiles(initial));

  const built = await runCli(root, ["build", "--isolated"]);
  expect(built.exitCode, built.output).toBe(0);
  let lines = await markerLines(root);
  expectPair(lines, "config", initial);
  expectPair(lines, "build", initial);
  const runtimePackage = JSON.parse(
    await readFile(join(root, ".blume-verify/package.json"), "utf-8")
  ) as { dependencies: Record<string, string> };
  expect(runtimePackage.dependencies["site-integration"]).toBeUndefined();

  await writeFile(join(root, "integration-markers.log"), "", "utf-8");
  const { output, port, proc } = await startDev(root);
  let failure: unknown;
  try {
    await waitForLine(root, "server:second");
    await waitForDevServer(port);
    lines = await markerLines(root);
    expectPair(lines, "config", initial);
    expectPair(lines, "server", initial);
    const hashBefore = await generatedConfigHash(root);
    expect(hashBefore).not.toBeNull();
    const markerCountBefore = lines.length;

    await writeFile(
      join(root, "blume.config.ts"),
      configSource(updated),
      "utf-8"
    );
    await waitForConfigHashChange(root, hashBefore as string);
    await waitForMarkerCount(root, markerCountBefore + 1);
    const settledMarkers = await markerLines(root);
    const settledMarkerCount = settledMarkers.length;
    await Bun.sleep(1000);
    const stableMarkers = await markerLines(root);
    expect(stableMarkers.length).toBe(settledMarkerCount);
  } catch (error) {
    failure = error;
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }
  const [stdout, stderr] = await output;
  if (failure) {
    throw new Error(`${String(failure)}\n${stdout}\n${stderr}`);
  }

  // The supported guarantee for edited Integration content is a new dev
  // process. Verify the updated hooks after an explicit process restart.
  await writeFile(join(root, "integration-markers.log"), "", "utf-8");
  const restarted = await startDev(root);
  failure = undefined;
  try {
    await waitForLine(root, "server:updated-second");
    lines = await markerLines(root);
    expectPair(lines, "config", updated);
    expectPair(lines, "server", updated);
  } catch (error) {
    failure = error;
  } finally {
    restarted.proc.kill("SIGTERM");
    await restarted.proc.exited;
  }
  const [restartStdout, restartStderr] = await restarted.output;
  if (failure) {
    throw new Error(`${String(failure)}\n${restartStdout}\n${restartStderr}`);
  }
}, 60_000);

it("passes invalid integration elements through to Astro validation", async () => {
  const root = await writeProject({
    "blume.config.ts": 'export default { integrations: ["invalid"] };\n',
    "docs/index.md": "# Home\n",
  });

  const built = await runCli(root, ["build", "--isolated"]);

  expect(built.exitCode).not.toBe(0);
  expect(built.output).toMatch(/integrations?/iu);
  expect(built.output).not.toContain("BLUME_CONFIG_INVALID");
}, 30_000);
