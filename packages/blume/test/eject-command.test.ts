import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("falls back to npm's `run` form without a user agent", async () => {
    const root = await fixture({
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const { exitCode, output } = await runEject(root, undefined, "--yes");
    expect(exitCode).toBe(0);
    expect(output).toContain("npm run dev");
    expect(output).toContain("npm run build");
  });

  it("lists the blume-build artifacts the ejected app stops producing", async () => {
    const root = await fixture({
      "blume.config.ts":
        'export default { search: { provider: "pagefind" } };\n',
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    // The confirmation (no --yes) already carries the config-aware notice, so
    // the decision is informed before anything is written.
    const { exitCode, output } = await runEject(root);
    expect(exitCode).toBe(0);
    expect(output).toContain("astro build && pagefind --site dist");
    expect(output).toContain("llms.txt");
    expect(output).toContain("robots.txt");
    // No deployment.site, so no sitemap was being produced — an inactive
    // artifact must not be listed.
    expect(output).not.toContain("sitemap.xml");
    expect(existsSync(join(root, "astro.config.mjs"))).toBe(false);
  });

  it("surfaces generation warnings like the runtime path does", async () => {
    const root = await fixture({
      "blume.config.ts":
        'export default { openapi: { enabled: true, renderer: "scalar", spec: "missing.json" } };\n',
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
