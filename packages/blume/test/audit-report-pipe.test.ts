import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { envWith } from "./process-fixture.ts";

/**
 * A failing `blume audit` must deliver its whole report through a pipe. The
 * report goes to stderr, and exiting with `process.exit(1)` right after the
 * write cut it off after the pipe's first buffer — the tail, with the summary,
 * never reached the CI log.
 */

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-audit-pipe-"));
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

/**
 * Enough broken body links that the --verbose report runs to about 2 MB — far
 * past what a pipe buffers, so a reader that keeps up still loses the tail.
 */
const LINKS = 12_000;

const page = (): string => {
  const links = Array.from(
    { length: LINKS },
    (_, index) =>
      `<a href="/a-page-that-was-never-built-${index}">Link ${index}</a>`
  ).join("\n");
  return `<!doctype html><html lang="en"><head>
<title>The home page of the site</title>
<meta name="description" content="A home page description that is comfortably longer than the hundred and ten characters the audit wants.">
<meta name="viewport" content="width=device-width">
<link rel="canonical" href="https://x.dev/">
</head><body><main><h1>Home</h1>
<p>${"word ".repeat(60)}</p>
${links}
</main></body></html>
`;
};

describe("blume audit through a pipe", () => {
  it("delivers the whole report before exiting non-zero", async () => {
    const root = await fixture({
      "blume.config.ts":
        'export default { title: "Test", deployment: { site: "https://x.dev" } };\n',
      "dist/index.html": page(),
      "docs/index.mdx": "---\ntitle: Home\n---\n\nBody.\n",
    });
    const proc = Bun.spawn([process.execPath, CLI, "audit", "--verbose"], {
      cwd: root,
      env: envWith({}),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);

    expect(exitCode).toBe(1);
    // Booleans, not `toContain`: a failure would otherwise print the report.
    expect(stderr.length > 1024 * 1024).toBe(true);
    expect(stderr.includes(`/a-page-that-was-never-built-${LINKS - 1},`)).toBe(
      true
    );
  }, 60_000);
});
