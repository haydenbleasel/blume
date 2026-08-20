import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-version-command-"));
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

const run = async (
  root: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    // bun test exports NODE_ENV=test, which drops consola's default level to
    // warnings-only in the child — raise it so info/success output is visible.
    env: { ...process.env, CONSOLA_LEVEL: "3" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

describe("blume version", () => {
  it("lists configured versions when no id is given", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  versions: {
    archived: [{ id: "v1.0", label: "1.0" }],
    current: { badge: "Latest", label: "2.0" },
  },
};
`,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const result = await run(root, ["version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2.0 (current) — Latest");
    expect(result.stdout).toContain("1.0 — v1.0/");
  });

  it("points at the docs when versioning is unconfigured", async () => {
    const root = await makeProject({
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const result = await run(root, ["version"]);
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Versioning is not configured"
    );
  });

  it("cuts a snapshot through the positional id", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  versions: { archived: [], current: { label: "v2.0" } },
};
`,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const result = await run(root, ["version", "v1.0"]);
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Snapshot");
  });

  it("reports a CutError as a user error with exit code 1", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  versions: { archived: [], current: { label: "v2.0" } },
};
`,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const result = await run(root, ["version", "1.0"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "must start with a letter"
    );
  });

  it("reports a missing content root as a user error", async () => {
    const root = await makeProject({
      "blume.config.ts": "export default {};\n",
    });
    const result = await run(root, ["version", "v1.0"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Content root not found"
    );
  });

  it("does not shadow the --version flag", async () => {
    const root = await makeProject({});
    const result = await run(root, ["--version"]);
    expect(result.exitCode).toBe(0);
    // citty prints the CLI version, not the subcommand's output.
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/u);
    expect(result.stdout).not.toContain("current");
  });
});
