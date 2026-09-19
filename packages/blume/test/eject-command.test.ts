import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

/**
 * `blume eject` exercised end-to-end as a subprocess: the success box must
 * print run commands matching the invoking package manager (detected from
 * `npm_config_user_agent`, like `blume init`), not hardcoded Bun ones.
 */

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-eject-cmd-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const runEject = async (
  cwd: string,
  userAgent?: string,
  ...args: string[]
): Promise<{ exitCode: number; output: string }> => {
  const env = { ...process.env };
  delete env.npm_config_user_agent;
  if (userAgent !== undefined) {
    env.npm_config_user_agent = userAgent;
  }
  // `bun test` sets NODE_ENV=test, which lowers consola's default log level
  // and silences the success box this suite asserts on.
  delete env.NODE_ENV;
  const proc = Bun.spawn(["bun", CLI, "eject", ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
};

describe("blume eject", () => {
  it("refuses without --yes and writes nothing", async () => {
    const root = await fixture({
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const { exitCode, output } = await runEject(root);
    expect(exitCode).toBe(0);
    expect(output).toContain("--yes");
    expect(existsSync(join(root, "astro.config.mjs"))).toBe(false);
  });

  it("prints run commands for the detected package manager", async () => {
    const root = await fixture({
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const { exitCode, output } = await runEject(
      root,
      "pnpm/9.1.0 npm/? node/v20.0.0",
      "--yes"
    );
    expect(exitCode).toBe(0);
    expect(existsSync(join(root, "astro.config.mjs"))).toBe(true);
    expect(output).toContain("pnpm dev");
    expect(output).toContain("pnpm build");
    expect(output).not.toContain("bun run dev");
  });

  it("prints `bun run build` for bun, whose bare `build` is the bundler", async () => {
    const root = await fixture({
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const { exitCode, output } = await runEject(
      root,
      "bun/1.3.0 npm/? node/v22.0.0",
      "--yes"
    );
    expect(exitCode).toBe(0);
    expect(output).toContain("bun dev");
    expect(output).toContain("bun run build");
  });

  it("falls back to npm's `run` form without a user agent", async () => {
    const root = await fixture({
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const { exitCode, output } = await runEject(root, undefined, "--yes");
    expect(exitCode).toBe(0);
    expect(output).toContain("npm run dev");
    expect(output).toContain("npm run build");
  });

  it("keeps the deploy artifacts through the integration's build hook", async () => {
    const root = await fixture({
      "blume.config.ts":
        // A hand-written descriptor: the same JSON `pagefind()` returns.
        'export default { search: { kind: "pagefind", mode: "pagefind", options: {}, requiredSecrets: [], runtimeDeps: [] } };\n',
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    // The confirmation (no --yes) writes nothing.
    const confirm = await runEject(root);
    expect(confirm.exitCode).toBe(0);
    expect(existsSync(join(root, "astro.config.mjs"))).toBe(false);

    const { exitCode } = await runEject(root, undefined, "--yes");
    expect(exitCode).toBe(0);
    // The ejected config tells `astro:build:done` to scan the project root, so
    // plain `astro build` still produces the search index, llms.txt, sitemap,
    // robots, and the platform files — nothing to warn about on the way out.
    const config = await readFile(join(root, "astro.config.mjs"), "utf-8");
    expect(config).toContain('"buildArtifactsRoot":"."');
  });

  it("surfaces generation warnings like the runtime path does", async () => {
    const root = await fixture({
      "blume.config.ts":
        'export default { reference: [{ kind: "openapi", options: { renderer: { kind: "scalar", options: {}, requiredSecrets: [], runtimeDeps: ["@scalar/astro"] }, spec: "missing.json" }, requiredSecrets: [], runtimeDeps: [] }] };\n',
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const { exitCode, output } = await runEject(root, undefined, "--yes");
    expect(exitCode).toBe(0);
    // The Scalar reference's missing-spec warning must not be swallowed: the
    // page ships pointing at a spec URL that will 404.
    expect(output).toContain('API reference spec not found: "missing.json"');
    expect(existsSync(join(root, "src/pages/reference.astro"))).toBe(true);
  });
});
