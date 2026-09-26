import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  envWith,
  pathWithBin,
  pathWithoutAgents,
  writeExecutable,
} from "./process-fixture.ts";

/**
 * `blume skill` end-to-end as a subprocess: the plan it reports and the
 * handoff, with fake `claude`/`codex` executables recording the prompt
 * instead of a real agent.
 */

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const SITE = {
  "blume.config.ts":
    'export default { title: "Acme", deployment: { site: "https://docs.example.com" } };\n',
  "docs/index.md": "# Home\n",
};

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-skill-cmd-"));
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

const skill = async (
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): Promise<{ exitCode: number; stderr: string }> => {
  // `process.execPath`, not `"bun"`: the agent tests replace PATH, and the
  // CLI still has to be launchable without one.
  const proc = Bun.spawn([process.execPath, CLI, "skill", ...args], {
    cwd,
    env: envWith(env),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
};

/** A fake agent that records the prompt it was launched with. */
const fakeAgent = async (
  root: string,
  name: string,
  exitCode = 0
): Promise<string> => {
  const dir = join(root, "fake-bin");
  await mkdir(dir, { recursive: true });
  await writeExecutable(
    dir,
    name,
    `const fs = require("node:fs");
const path = require("node:path");
const handoff = process.argv[2] ?? "";
const pointer = /^Read (.+) and follow its instructions exactly\\.$/u.exec(handoff)?.[1];
const prompt = pointer ? fs.readFileSync(pointer, "utf8") : handoff;
fs.writeFileSync(path.join(__dirname, "prompt.txt"), prompt);
process.exit(${exitCode});`
  );
  return dir;
};

describe("blume skill", () => {
  it("hands the skill to Claude Code with the plan", async () => {
    const root = await fixture(SITE);
    const bin = await fakeAgent(root, "claude");
    const { exitCode, stderr } = await skill(
      root,
      { PATH: pathWithBin(bin) },
      "--claude"
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain(
      'Writing the "acme" skill at skills/acme/SKILL.md.'
    );
    expect(stderr).toContain("Handing it to Claude Code");
    const prompt = await readFile(join(bin, "prompt.txt"), "utf-8");
    expect(prompt).toContain(join("skills", "blume-write-skill", "SKILL.md"));
    expect(prompt).toContain("Write it to skills/acme/SKILL.md.");
  });

  it("updates an existing skill with Codex, passing its exit code through", async () => {
    const root = await fixture({
      ...SITE,
      "skills/acme/SKILL.md": "---\nname: acme\n---\n",
    });
    const bin = await fakeAgent(root, "codex", 3);
    const { exitCode, stderr } = await skill(
      root,
      { PATH: pathWithBin(bin) },
      "--codex"
    );
    expect(exitCode).toBe(3);
    expect(stderr).toContain('Updating the "acme" skill');
  });

  it("points any other agent at the skill without an agent flag", async () => {
    const root = await fixture(SITE);
    const { exitCode, stderr } = await skill(root, {});
    expect(exitCode).toBe(0);
    expect(stderr).toContain("rerun with --codex or --claude");
    expect(stderr).toContain(join("skills", "blume-write-skill", "SKILL.md"));
    expect(stderr).toContain(
      "npx skills add haydenbleasel/blume --skill blume-write-skill"
    );
  });

  it("refuses both agents at once", async () => {
    const root = await fixture(SITE);
    const { exitCode, stderr } = await skill(root, {}, "--claude", "--codex");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Pass at most one of --codex or --claude.");
  });

  it("explains how to install a missing agent CLI", async () => {
    const root = await fixture(SITE);
    const { exitCode, stderr } = await skill(
      root,
      { PATH: await pathWithoutAgents() },
      "--codex"
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("was not found on PATH");
  });

  it("reports an invalid config", async () => {
    const root = await fixture({
      "blume.config.ts": "export default { title: 3 };\n",
      "docs/index.md": "# Home\n",
    });
    const { exitCode, stderr } = await skill(root, {});
    expect(exitCode).toBe(1);
    expect(stderr).toContain("BLUME_CONFIG_INVALID");
  });
});
