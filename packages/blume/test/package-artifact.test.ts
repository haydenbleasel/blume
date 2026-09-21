import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { join } from "pathe";

const PACKAGE_ROOT = join(import.meta.dir, "..");

interface PackageManifest {
  files?: string[];
}

const run = async (
  args: string[]
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn(args, {
    cwd: PACKAGE_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
};

describe("package artifact", () => {
  it("ships agent guidance alongside the bundled skills", async () => {
    // SAFETY: package.json is the package manifest with an optional files list.
    const manifest = JSON.parse(
      await readFile(join(PACKAGE_ROOT, "package.json"), "utf-8")
    ) as PackageManifest;
    expect(manifest.files).toContain("AGENTS.md");
    expect(manifest.files).toContain("skills");

    const bundle = await run(["bun", "run", "scripts/bundle-docs.mjs"]);
    expect(bundle.exitCode).toBe(0);

    const packed = await run(["bun", "pm", "pack", "--dry-run"]);
    expect(packed.exitCode).toBe(0);
    expect(packed.output).toMatch(/^packed \S+ AGENTS\.md$/mu);
    expect(packed.output).toMatch(/^packed \S+ skills\/.*\/SKILL\.md$/mu);
  }, 60_000);
});
