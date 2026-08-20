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
import type { AddressInfo } from "node:net";

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

const fixtureFiles = (labels: string[]) => ({
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
    // Race the predicate against the deadline: a probe that never settles
    // would otherwise disable this timeout AND every retry built on it,
    // wedging the test until its outer budget with no error (#121).
    const result = await Promise.race([
      Promise.resolve().then(predicate),
      Bun.sleep(Math.max(expiresAt - Date.now(), 0)).then(
        () => "deadline" as const
      ),
    ]);
    if (result === true) {
      return;
    }
    if (result === "deadline" || Date.now() >= expiresAt) {
      throw new Error(timeoutMessage);
    }
    await Bun.sleep(50);
    return poll();
  };
  return poll();
};

/**
 * Await a child's piped output without trusting the pipe to close. A
 * toolchain grandchild (e.g. an esbuild service) inherits the write end and
 * can outlive even a SIGKILLed parent, so the stream never reaches EOF and a
 * bare await hangs the test to its full budget — swallowing the error the
 * output was meant to annotate (#121). `Bun.spawn` offers no process-group
 * kill to reap such orphans, so give up on the drain instead.
 */
const drainOutput = (
  output: Promise<[string, string]>,
  timeout = 5000
): Promise<[string, string]> =>
  Promise.race([
    output,
    Bun.sleep(timeout).then((): [string, string] => [
      "<output unavailable: pipe still held after drain timeout>",
      "",
    ]),
  ]);

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

/**
 * Wait until the marker log stops growing for a full quiet window. A config
 * restart appends its markers over a stretch of time, so a fixed-length sleep
 * taken mid-restart races it; a restart *loop* never goes quiet and times out.
 */
const waitForQuiescentMarkers = async (
  root: string,
  quietWindow = 1000,
  timeout = 30_000
): Promise<string[]> => {
  const expiresAt = Date.now() + timeout;
  const settle = async (previous: number): Promise<string[]> => {
    await Bun.sleep(quietWindow);
    const lines = await markerLines(root);
    if (lines.length === previous) {
      return lines;
    }
    if (Date.now() >= expiresAt) {
      throw new Error("Timed out waiting for integration markers to settle.");
    }
    return settle(lines.length);
  };
  const startingLines = await markerLines(root);
  return settle(startingLines.length);
};

const isAddressInfo = (
  value: AddressInfo | string | null
): value is AddressInfo => Boolean(value) && typeof value !== "string";

const availablePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = isAddressInfo(address) ? address.port : null;
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
        // A wedged server can bind the port yet never answer; an unbounded
        // fetch would then hang this poll (and the whole test) forever.
        await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(2000),
        });
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

const stopDev = async (
  proc: Awaited<ReturnType<typeof startDev>>["proc"]
): Promise<void> => {
  proc.kill("SIGTERM");
  const exited = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(5000).then(() => false),
  ]);
  if (!exited) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
};

/**
 * Astro's dev startup occasionally wedges after `astro:server:setup` and never
 * reaches listen (observed intermittently on macOS). One relaunch gets past the
 * transient wedge; a persistent startup failure still surfaces after the retry.
 */
const startDevReady = async (
  root: string,
  attemptsLeft = 2
): Promise<Awaited<ReturnType<typeof startDev>>> => {
  const session = await startDev(root);
  try {
    await waitForDevServer(session.port);
    return session;
  } catch (error) {
    await stopDev(session.proc);
    // A wedged shutdown can strand the dev lock; clear it for the relaunch.
    await rm(join(root, ".blume/dev.lock"), { force: true });
    if (attemptsLeft <= 1) {
      const [stdout, stderr] = await drainOutput(session.output);
      throw new Error(`${String(error)}\n${stdout}\n${stderr}`, {
        cause: error,
      });
    }
    return startDevReady(root, attemptsLeft - 1);
  }
};

/** A CLI subprocess had to be killed because it never exited on its own. */
class CliTimeoutError extends Error {
  override name = "CliTimeoutError";
}

const runCli = async (
  root: string,
  args: string[],
  timeout = 120_000
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const outputText = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(timeout).then(() => null),
  ]);
  if (exitCode === null) {
    proc.kill("SIGTERM");
    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    const [stdout, stderr] = await drainOutput(outputText);
    throw new CliTimeoutError(
      `\`blume ${args.join(" ")}\` did not exit within ${timeout}ms\n${stdout}\n${stderr}`
    );
  }
  const [stdout, stderr] = await drainOutput(outputText);
  return { exitCode, output: `${stdout}\n${stderr}` };
};

/**
 * `blume build --isolated` on CI occasionally wedges after Astro logs
 * `Complete!`: the build succeeds but the process never exits, and without a
 * guard the runner kills it at the test timeout (exit 143) — the build-side
 * sibling of the dev startup wedge above. Kill the hung process and rebuild
 * once; a persistent hang still surfaces after the retry.
 *
 * A second CI flake lives in Astro's fonts pipeline: the default theme fonts
 * download from Google at build time, and Google's CSS API occasionally hands
 * out gstatic URLs that 404 mid-rollout, failing the build with
 * `CannotFetchFontFile`. Drop the runtime's font cache (a cached stale URL
 * list would just re-404) and rebuild once; a real outage still surfaces
 * after the retry.
 */
const runIsolatedBuild = async (
  root: string,
  attemptsLeft = 2
): Promise<{ exitCode: number; output: string }> => {
  let result: { exitCode: number; output: string };
  try {
    result = await runCli(root, ["build", "--isolated"], 90_000);
  } catch (error) {
    if (!(error instanceof CliTimeoutError) || attemptsLeft <= 1) {
      throw error;
    }
    return runIsolatedBuild(root, attemptsLeft - 1);
  }
  if (
    result.exitCode !== 0 &&
    result.output.includes("CannotFetchFontFile") &&
    attemptsLeft > 1
  ) {
    await rm(join(root, ".blume-verify/.astro/fonts"), {
      force: true,
      recursive: true,
    });
    return runIsolatedBuild(root, attemptsLeft - 1);
  }
  return result;
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

  const built = await runIsolatedBuild(root);
  expect(built.exitCode, built.output).toBe(0);
  let lines = await markerLines(root);
  expectPair(lines, "config", initial);
  expectPair(lines, "build", initial);
  // SAFETY: the generated runtime package.json always declares a
  // `dependencies` map (generate.ts writes one unconditionally).
  const runtimePackage = JSON.parse(
    await readFile(join(root, ".blume-verify/package.json"), "utf-8")
  ) as { dependencies: Record<string, string> };
  expect(runtimePackage.dependencies["site-integration"]).toBeUndefined();

  await writeFile(join(root, "integration-markers.log"), "", "utf-8");
  const { output, proc } = await startDevReady(root);
  let failure: unknown;
  try {
    await waitForLine(root, "server:second");
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
    // SAFETY: the expect above already failed the test if hashBefore is null.
    await waitForConfigHashChange(root, hashBefore as string);
    await waitForMarkerCount(root, markerCountBefore + 1);
    const settledMarkers = await waitForQuiescentMarkers(root);
    // One restart re-runs config + server hooks for both integrations (4
    // markers). Astro's config watcher can deliver a second in-place restart
    // for a single write (timing-dependent), so allow up to two restarts;
    // anything past that means the edit triggered a regeneration loop.
    expect(settledMarkers.length - markerCountBefore).toBeLessThanOrEqual(8);
  } catch (error) {
    failure = error;
  } finally {
    await stopDev(proc);
  }
  const [stdout, stderr] = await drainOutput(output);
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
    await stopDev(restarted.proc);
  }
  const [restartStdout, restartStderr] = await drainOutput(restarted.output);
  if (failure) {
    throw new Error(`${String(failure)}\n${restartStdout}\n${restartStderr}`);
  }
  // Budget for a killed-and-retried 90s build attempt on top of the dev phases.
}, 300_000);

it("passes invalid integration elements through to Astro validation", async () => {
  const root = await writeProject({
    "blume.config.ts": 'export default { integrations: ["invalid"] };\n',
    "docs/index.md": "# Home\n",
  });

  const built = await runIsolatedBuild(root);

  expect(built.exitCode).not.toBe(0);
  expect(built.output).toMatch(/integrations?/iu);
  expect(built.output).not.toContain("BLUME_CONFIG_INVALID");
  // Budget for a killed-and-retried 90s build attempt.
}, 240_000);
