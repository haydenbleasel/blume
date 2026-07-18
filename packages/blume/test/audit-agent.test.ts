import { afterAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  AGENTS,
  fixPrompt,
  launchAgent,
  writeAgentReport,
} from "../src/audit/agent.ts";
import type { AuditResult } from "../src/audit/run.ts";

/** The `--claude`/`--codex` handoff: the report file, the prompt, the launch. */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const result = (diagnostics: AuditResult["diagnostics"]): AuditResult => ({
  diagnostics,
  origin: null,
  pages: 10,
  staticDir: "/root/dist",
  tiers: { external: false, network: false, static: true },
});

describe("AGENTS", () => {
  it("names the executable and the install command for both agents", () => {
    expect(AGENTS.claude.bin).toBe("claude");
    expect(AGENTS.codex.bin).toBe("codex");
    for (const agent of Object.values(AGENTS)) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.install).toContain("npm install -g");
    }
  });
});

describe("writeAgentReport", () => {
  it("writes the full JSON report with root-relative source files", async () => {
    const path = await writeAgentReport(
      result([
        {
          code: "BLUME_AUDIT_TITLE_MISSING",
          file: "/root/docs/index.mdx",
          line: 2,
          message: "Page has no <title>.",
          severity: "warning",
          suggestion: "Add a `title` to the front matter.",
          url: "/",
        },
      ]),
      "/root"
    );
    dirs.push(dirname(path));

    expect(path.startsWith(join(tmpdir(), "blume-audit-"))).toBe(true);
    const payload = JSON.parse(await readFile(path, "utf-8"));
    expect(payload.audit.pages).toBe(10);
    // The agent edits files by these paths, so they must be root-relative —
    // the agent runs in the project root, not wherever the report says.
    expect(payload.diagnostics[0].file).toBe("docs/index.mdx");
    expect(payload.diagnostics[0].suggestion).toContain("front matter");
  });
});

describe("fixPrompt", () => {
  it("names the report path and the verify loop", () => {
    const prompt = fixPrompt("/tmp/blume-audit-x/report.json");
    expect(prompt).toContain("/tmp/blume-audit-x/report.json");
    // The agent has to rebuild before re-auditing — the audit reads dist/,
    // and the fixes land in .mdx sources.
    expect(prompt).toContain("`blume build`");
    expect(prompt).toContain("`blume audit`");
    expect(prompt).toContain("`suggestion`");
  });

  it("forbids fixing by deletion", () => {
    expect(fixPrompt("/tmp/report.json")).toContain("Never fix a finding");
  });
});

describe("launchAgent", () => {
  it("resolves with the agent's exit code", async () => {
    expect(await launchAgent("true", "prompt")).toBe(0);
    expect(await launchAgent("false", "prompt")).toBe(1);
  });

  it("passes the prompt as the agent's first argument", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-audit-agent-"));
    dirs.push(dir);
    const bin = join(dir, "agent");
    await writeFile(
      bin,
      `#!/bin/sh\nprintf '%s' "$1" > "$(dirname "$0")/prompt.txt"\n`
    );
    await chmod(bin, 0o755);

    expect(await launchAgent(bin, "fix the site")).toBe(0);
    expect(await readFile(join(dir, "prompt.txt"), "utf-8")).toBe(
      "fix the site"
    );
  });

  it("rejects when the executable is not on PATH", async () => {
    // Node rejects with `spawn <bin> ENOENT`, Bun with its own wording — the
    // caller treats any launch error as "not installed", so assert only that.
    await expect(
      launchAgent("blume-agent-that-does-not-exist", "prompt")
    ).rejects.toThrow();
  });
});
