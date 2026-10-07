import { afterAll, expect, it } from "bun:test";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
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

/**
 * Every fixture pins the theme's font roles to a local file so no dev or
 * build start reaches Google Fonts. Astro's fonts plugin resolves remote
 * families in `buildStart`, which Vite awaits before the dev server listens,
 * and unifont's metadata fetch has no timeout — a stalled fonts.google.com
 * held startup past the readiness budget (and its retry) on CI, and the same
 * pipeline fails builds with `CannotFetchFontFile` when Google hands out
 * gstatic URLs that 404 mid-rollout. KaTeX, a Blume dependency, ships a real
 * font file to point at.
 */
const LOCAL_FONT = join(
  PACKAGE_ROOT,
  "node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2"
);
const localFont = { name: "Probe", variants: [{ src: LOCAL_FONT }] };
const offlineFontsSource = `theme: { fonts: ${JSON.stringify({
  body: localFont,
  display: localFont,
  mono: localFont,
})} }`;

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
  ${offlineFontsSource},
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

/**
 * Collect a piped stream to a string while handing every growing prefix to
 * `onText`, so a caller can react to a line the moment it lands instead of
 * after the process exits.
 */
const collectOutput = async (
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void
): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    onText(text);
  }
  return text + decoder.decode();
};

/**
 * Wait for the dev server to announce its address, then for it to answer.
 *
 * The port must not be touched before the announcement. Vite checks that the
 * requested port is free by binding a throwaway `net.Server` to each wildcard
 * address and closing it inside its `listening` callback, all before the real
 * server binds. A readiness connect that lands in that window is accepted by
 * the throwaway server, and under Bun (which runs the CLI here) `close()`
 * then never calls back: Vite's availability check hangs, the real server
 * never listens, and the output ends right after `[content] Synced content`.
 * Polling the port every 50ms against three sub-millisecond windows hit
 * about 7% of starts on the Linux runners and never on macOS. Vite prints
 * `Local http://…` only once the real server is bound, so waiting for that
 * line makes the first connect safe.
 */
const waitForDevServer = async (
  session: { isListening: () => boolean; port: number },
  timeout = 30_000
): Promise<void> => {
  const expiresAt = Date.now() + timeout;
  await waitUntil(
    session.isListening,
    `Timed out waiting for dev server on port ${session.port}.`,
    timeout
  );
  await waitUntil(
    async () => {
      try {
        // A wedged server can bind the port yet never answer; an unbounded
        // fetch would then hang this poll (and the whole test) forever.
        await fetch(`http://127.0.0.1:${session.port}/`, {
          signal: AbortSignal.timeout(2000),
        });
        return true;
      } catch {
        return false;
      }
    },
    `Dev server on port ${session.port} announced itself but never answered.`,
    Math.max(expiresAt - Date.now(), 0)
  );
};

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
  // Vite's startup banner names the bound address; see `waitForDevServer`.
  let listening = false;
  const output = Promise.all([
    collectOutput(proc.stdout, (text) => {
      listening ||= text.includes(`http://127.0.0.1:${port}/`);
    }),
    collectOutput(proc.stderr, () => {}),
  ]);
  return { isListening: () => listening, output, port, proc };
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
 * Relaunch once if the dev server never reaches listen. The fixtures' local
 * fonts (see `offlineFontsSource`) and the announcement-gated readiness wait
 * (see `waitForDevServer`) remove the known causes — Astro waiting on Google
 * Fonts before listening, and a readiness connect wedging Vite's port check —
 * so this only guards a persistent startup failure, which still surfaces
 * after the retry.
 */
const startDevReady = async (
  root: string,
  attemptsLeft = 2
): Promise<Awaited<ReturnType<typeof startDev>>> => {
  const session = await startDev(root);
  try {
    await waitForDevServer(session);
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
 * guard the runner kills it at the test timeout (exit 143). Kill the hung
 * process and rebuild once; a persistent hang still surfaces after the retry.
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
    "blume.config.ts": `export default { integrations: ["invalid"], ${offlineFontsSource} };\n`,
    "docs/index.md": "# Home\n",
  });

  const built = await runIsolatedBuild(root);

  expect(built.exitCode).not.toBe(0);
  expect(built.output).toMatch(/integrations?/iu);
  expect(built.output).not.toContain("BLUME_CONFIG_INVALID");
  // Budget for a killed-and-retried 90s build attempt.
}, 240_000);

it("renders agents.mcp.clients in the built Connect to MCP menu", async () => {
  const root = await writeProject({
    "blume.config.ts": `
import { node } from "blume/deploy";

export default {
  agents: {
    mcp: {
      clients: [
        {
          command: "copilot mcp add --transport http {name} {url}",
          label: "Copy Copilot CLI command",
        },
        "vscode",
      ],
      enabled: true,
    },
  },
  deployment: node({ site: "https://docs.example.com" }),
  ${offlineFontsSource},
};
`,
    "docs/index.md": "# Home\n",
  });

  const built = await runIsolatedBuild(root);
  expect(built.exitCode, built.output).toBe(0);
  const html = await readFile(
    join(root, ".blume-verify/dist/client/index.html"),
    "utf-8"
  );
  // The menu's rows in order: the server URL, the configured clients, and a
  // rule where the commands to copy give way to the install links.
  const menu = html.slice(
    html.indexOf("data-mcp-copy-url"),
    html.indexOf("</details>", html.indexOf("data-mcp-copy-url"))
  );
  expect(
    [...menu.matchAll(/<hr\b|data-mcp-(?:copy-[a-z]+|cursor|vscode)\b/gu)].map(
      ([row]) => row
    )
  ).toStrictEqual([
    "data-mcp-copy-url",
    "data-mcp-copy-command",
    "<hr",
    "data-mcp-vscode",
  ]);
  // The custom row carries its command for the script to fill in, under its
  // label, beside the server the script fills it with.
  expect(menu).toContain(
    'data-mcp-copy-command="copilot mcp add --transport http {name} {url}"'
  );
  expect(menu).toContain("Copy Copilot CLI command");
  expect(html).toContain('data-mcp-url="https://docs.example.com/mcp"');
  // Budget for a killed-and-retried 90s build attempt.
}, 240_000);

it("serves a renamed content folder in dev without restarting the server", async () => {
  // Astro's glob watcher misses directory renames. Rather than restart the
  // dev server, the regenerate loop asks Astro's content layer to re-sync
  // (`refreshContent`), so the moved page answers under its new route while
  // the server stays up — its startup banner prints exactly once.
  const root = await writeProject({
    "blume.config.ts": `export default { ${offlineFontsSource} };\n`,
    "docs/guides/setup.md":
      "---\ntitle: Setup\n---\n# Setup\n\nrenamed probe\n",
    "docs/index.md": "# Home\n",
  });
  const { output, port, proc } = await startDevReady(root);
  const page = (path: string, timeout: number) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeout),
    });
  let failure: unknown;
  try {
    const before = await page("/guides/setup", 60_000);
    expect(before.status).toBe(200);
    await rename(join(root, "docs/guides"), join(root, "docs/handbook"));
    await waitUntil(
      async () => {
        try {
          const response = await page("/handbook/setup", 5000);
          const body = await response.text();
          return response.status === 200 && body.includes("renamed probe");
        } catch {
          return false;
        }
      },
      "Timed out waiting for the renamed page to be served.",
      90_000
    );
    const gone = await page("/guides/setup", 10_000);
    expect(gone.status).toBe(404);
  } catch (error) {
    failure = error;
  } finally {
    await stopDev(proc);
  }
  const [stdout, stderr] = await drainOutput(output);
  if (failure) {
    throw new Error(`${String(failure)}\n${stdout}\n${stderr}`);
  }
  // Astro prints its `ready in` banner once per `dev()` call; a second one
  // would mean the loop fell back to a cold restart.
  expect(`${stdout}${stderr}`.match(/ready in/gu) ?? []).toHaveLength(1);
}, 240_000);

it("negotiates Markdown for content routes under deployment.base in dev", async () => {
  // Astro's dev base middleware rewrites `/sub/guide` to `/guide` before the
  // negotiation handler runs; stripping the base a second time left every
  // request unmatched, so `Accept: text/markdown` served HTML on based sites.
  const root = await writeProject({
    "blume.config.ts": `export default { deployment: { base: "/sub" }, ${offlineFontsSource} };\n`,
    "docs/guide.md": "---\ntitle: Guide\n---\n# Guide\n\nprobe body\n",
    "docs/index.md": "# Home\n",
  });
  const { output, port, proc } = await startDevReady(root);
  let failure: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/sub/guide`, {
      headers: { accept: "text/markdown" },
      signal: AbortSignal.timeout(60_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("vary")).toContain("Accept");
    expect(await response.text()).toContain("probe body");
  } catch (error) {
    failure = error;
  } finally {
    await stopDev(proc);
  }
  const [stdout, stderr] = await drainOutput(output);
  if (failure) {
    throw new Error(`${String(failure)}\n${stdout}\n${stderr}`);
  }
}, 180_000);

it("answers trailing slashes the way a static host does in dev", async () => {
  // Astro's own dev middleware, which `trailingSlash: "never"` makes 404 a
  // slashed URL, runs ahead of every integration middleware; the redirect
  // has to come first, base and all.
  const root = await writeProject({
    "blume.config.ts": `export default { deployment: { base: "/sub" }, ${offlineFontsSource} };\n`,
    "docs/guide.md": "---\ntitle: Guide\n---\n# Guide\n",
    "docs/index.md": "# Home\n",
    "public/demo/index.html": "<p>demo folder</p>\n",
  });
  const { output, port, proc } = await startDevReady(root);
  const get = (path: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  let failure: unknown;
  try {
    const page = await get("/sub/guide/?tab=1");
    expect(page.status).toBe(301);
    expect(page.headers.get("location")).toBe("/sub/guide?tab=1");
    const slashless = await get("/sub/guide");
    expect(slashless.status).toBe(200);
    // A folder of HTML in `public/` is served at its slashed URL.
    const folder = await get("/sub/demo");
    expect(folder.status).toBe(301);
    expect(folder.headers.get("location")).toBe("/sub/demo/");
    const index = await get("/sub/demo/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("demo folder");
  } catch (error) {
    failure = error;
  } finally {
    await stopDev(proc);
  }
  const [stdout, stderr] = await drainOutput(output);
  if (failure) {
    throw new Error(`${String(failure)}\n${stdout}\n${stderr}`);
  }
}, 180_000);

it("serves deferred sidebar fragments on a route outside every header tab in dev", async () => {
  // With header tabs configured, a route under no tab renders the sidebar
  // minus the tab-owned sections. That pruned view must still address its
  // collapsed groups by their full-tree ids (`g<n>`) — a positional fallback
  // (`n.<index>`) names a fragment no route serves, so every group 404ed on
  // first open (#272). A container that lost a nested tab section (Guides,
  // minus the SDK tab) has no fragment at all: one would render the full
  // tree's version, section included, so it renders in full instead.
  const root = await writeProject({
    "blume.config.ts": `export default { i18n: { defaultLocale: "de", locales: [{ code: "de", label: "Deutsch" }] }, navigation: { sidebar: { display: "group" }, tabs: [{ label: "API", path: "/api" }, { label: "SDK", path: "/guides/sdk" }] }, ${offlineFontsSource} };\n`,
    "docs/api/files.md": "---\ntitle: Files\n---\n# Files\n",
    "docs/guides/advanced/tief.md": "---\ntitle: Tief\n---\n# Tief\n",
    "docs/guides/erste.md": "---\ntitle: Erste\n---\n# Erste\n",
    "docs/guides/sdk/install.md": "---\ntitle: Install\n---\n# Install\n",
    "docs/index.md": "# Start\n",
    "docs/reference/eins.md": "---\ntitle: Eins\n---\n# Eins\n",
  });
  const { output, port, proc } = await startDevReady(root);
  let failure: unknown;
  try {
    const page = await fetch(`http://127.0.0.1:${port}/reference/eins`, {
      signal: AbortSignal.timeout(60_000),
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    // Neither tab section is in the sidebar (the header tabs still link to
    // them); the rebuilt Guides container renders its remaining rows inline.
    const sidebar =
      html.match(/<nav data-blume-nav-tree>[\s\S]*?<\/nav>/u)?.[0] ?? "";
    expect(sidebar).not.toContain("/api/files");
    expect(sidebar).not.toContain("/guides/sdk/install");
    expect(sidebar).toContain("/guides/erste");
    const fragments = [...new Set(html.match(/\/blume-nav\/[^"'\s]+/gu))];
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) {
      expect(fragment).toMatch(/^\/blume-nav\/current\/default\/g\d+$/u);
    }
    const bodies = await Promise.all(
      fragments.map(async (fragment) => {
        const response = await fetch(`http://127.0.0.1:${port}${fragment}`, {
          signal: AbortSignal.timeout(60_000),
        });
        expect(response.status).toBe(200);
        return response.text();
      })
    );
    for (const body of bodies) {
      expect(body).toContain("blume-nav-link");
      expect(body).not.toContain("/guides/sdk/install");
    }
  } catch (error) {
    failure = error;
  } finally {
    await stopDev(proc);
  }
  const [stdout, stderr] = await drainOutput(output);
  if (failure) {
    throw new Error(`${String(failure)}\n${stdout}\n${stderr}`);
  }
}, 180_000);

it("serves deferred sidebar fragments for an unprefixed default locale in dev", async () => {
  // Astro's i18n routing (prefix-other-locales) 404s any page URL carrying the
  // default locale's code as a segment, so a `/blume-nav/current/de/…` fragment
  // URL never resolved on a site whose default locale is unprefixed. The
  // fragment base keys that locale `default`, the same way its pages drop the
  // prefix.
  const root = await writeProject({
    "blume.config.ts": `export default { i18n: { defaultLocale: "de", locales: [{ code: "de", label: "Deutsch" }] }, navigation: { sidebar: { display: "group" } }, ${offlineFontsSource} };\n`,
    "docs/guides/advanced/tief.md": "---\ntitle: Tief\n---\n# Tief\n",
    "docs/guides/erste.md": "---\ntitle: Erste\n---\n# Erste\n",
    "docs/index.md": "# Start\n",
  });
  const { output, port, proc } = await startDevReady(root);
  let failure: unknown;
  try {
    const page = await fetch(`http://127.0.0.1:${port}/guides/erste`, {
      signal: AbortSignal.timeout(60_000),
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    const fragments = [...new Set(html.match(/\/blume-nav\/[^"'\s]+/gu))];
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) {
      expect(fragment.startsWith("/blume-nav/current/default/")).toBe(true);
    }
    const bodies = await Promise.all(
      fragments.map(async (fragment) => {
        const response = await fetch(`http://127.0.0.1:${port}${fragment}`, {
          signal: AbortSignal.timeout(60_000),
        });
        expect(response.status).toBe(200);
        return response.text();
      })
    );
    for (const body of bodies) {
      expect(body).toContain("blume-nav-link");
    }
  } catch (error) {
    failure = error;
  } finally {
    await stopDev(proc);
  }
  const [stdout, stderr] = await drainOutput(output);
  if (failure) {
    throw new Error(`${String(failure)}\n${stdout}\n${stderr}`);
  }
}, 180_000);
