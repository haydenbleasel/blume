import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

import { join } from "pathe";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

interface PackageManifest {
  files?: string[];
}

const run = async (
  args: string[]
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn([process.execPath, ...args], {
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

    // The repo-root skills/ directory is the source of truth; the packaged
    // copy under packages/blume/skills is gitignored and regenerated here.
    const skillEntries = await readdir(join(REPO_ROOT, "skills"), {
      withFileTypes: true,
    });
    const skills = skillEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
    expect(skills.length).toBeGreaterThan(0);

    const guidance = await readFile(join(PACKAGE_ROOT, "AGENTS.md"), "utf-8");
    for (const skill of skills) {
      expect(guidance).toContain(`./skills/${skill}/SKILL.md`);
    }

    const bundle = await run(["run", "scripts/bundle-docs.mjs"]);
    expect(bundle.exitCode).toBe(0);

    // --ignore-scripts keeps the dry run from firing `prepack`, which would
    // rebuild dist/ in the working tree (bundle-docs already ran above).
    const packed = await run(["pm", "pack", "--dry-run", "--ignore-scripts"]);
    expect(packed.exitCode).toBe(0);
    expect(packed.output).toMatch(/^packed \S+ AGENTS\.md$/mu);
    for (const skill of skills) {
      expect(packed.output).toMatch(
        new RegExp(`^packed \\S+ skills/${skill}/SKILL\\.md$`, "mu")
      );
    }
  }, 60_000);
});
