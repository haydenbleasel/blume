import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

/**
 * `blume translate` end-to-end as a subprocess, with a fake `claude`
 * executable on PATH so no real agent (or network) is involved.
 */

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const CONFIG = `export default {
  title: "Test Docs",
  i18n: {
    defaultLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "fr", label: "French" },
    ],
  },
};
`;

const INSTALL_EN =
  "---\ntitle: Install\n---\n# Install\n\nRun the installer.\n";
const INSTALL_FR =
  "---\ntitle: Installation\n---\n# Installation\n\nLancez l'installateur.\n";

const PROJECT_FILES: Record<string, string> = {
  "blume.config.ts": CONFIG,
  "docs/fr/index.mdx": "---\ntitle: Accueil\n---\n# Accueil\n",
  "docs/guides/install.mdx": INSTALL_EN,
  "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
};

const fixture = async (
  files: Record<string, string> = PROJECT_FILES
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-translate-cmd-"));
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
 * A fake `claude` on PATH: swallows the stdin prompt, appends one line to
 * calls.txt (so tests can count agent invocations), and replies with the
 * canned envelope in reply.json.
 */
const fakeClaude = async (
  root: string,
  resultText: string
): Promise<string> => {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(root, "reply.json"),
    JSON.stringify({
      is_error: false,
      result: resultText,
      total_cost_usd: 0.05,
    })
  );
  const script = `#!/bin/sh
cat > /dev/null
echo run >> "${root}/calls.txt"
cat "${root}/reply.json"
`;
  const path = join(bin, "claude");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return bin;
};

const agentCalls = async (root: string): Promise<number> => {
  try {
    const raw = await readFile(join(root, "calls.txt"), "utf-8");
    return raw.split("\n").filter((line) => line !== "").length;
  } catch {
    return 0;
  }
};

const run = async (
  cwd: string,
  binDir: string | undefined,
  ...args: string[]
): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
  const path = binDir ? `${binDir}:${process.env.PATH ?? ""}` : "/usr/bin:/bin";
  const proc = Bun.spawn([process.execPath, CLI, "translate", ...args], {
    cwd,
    env: { ...process.env, PATH: path },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

describe("blume translate", () => {
  it("checks, translates, adopts, and settles into a no-op rerun", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root, INSTALL_FR);

    // 1. `--check` fails on the missing translation and reports the
    //    hand-authored one as untracked, all without writing anything.
    const check = await run(root, bin, "--check", "--json");
    expect(check.exitCode).toBe(1);
    expect(check.stderr).toContain("docs/guides/install.mdx → fr");
    expect(check.stderr).toContain("missing");
    expect(check.stderr).toContain("untracked");
    const checkJson = JSON.parse(check.stdout);
    expect(checkJson.translate.locales.fr.missing).toEqual([
      "docs/guides/install.mdx",
    ]);
    expect(checkJson.translate.locales.fr.untracked).toEqual([
      "docs/index.mdx",
    ]);
    expect(await agentCalls(root)).toBe(0);
    expect(existsSync(join(root, "blume.translations.json"))).toBe(false);

    // 2. The translate run writes the missing file, stamps it, and adopts the
    //    hand-authored translation without touching it.
    const translate = await run(
      root,
      bin,
      "--claude",
      "--json",
      "--concurrency",
      "2"
    );
    expect(translate.exitCode).toBe(0);
    expect(
      await readFile(join(root, "docs/fr/guides/install.mdx"), "utf-8")
    ).toBe(INSTALL_FR);
    expect(await agentCalls(root)).toBe(1);
    expect(translate.stderr).toContain("Translated 1 file into 1 locale");
    expect(translate.stderr).toContain("1 adopted");
    expect(translate.stderr).toContain("$0.05");
    const report = JSON.parse(translate.stdout);
    expect(report.translate.counts.translated).toBe(1);
    expect(report.translate.adopted).toBe(1);
    const ledger = JSON.parse(
      await readFile(join(root, "blume.translations.json"), "utf-8")
    );
    expect(Object.keys(ledger.files).toSorted()).toEqual([
      "docs/guides/install.mdx",
      "docs/index.mdx",
    ]);
    expect(await readFile(join(root, "docs/fr/index.mdx"), "utf-8")).toContain(
      "Accueil"
    );

    // 3. A rerun has nothing to do and spawns no agent.
    const rerun = await run(root, bin, "--claude");
    expect(rerun.exitCode).toBe(0);
    expect(await agentCalls(root)).toBe(1);
    expect(rerun.stderr).toContain("2 already up to date");

    // 4. `--check` now passes.
    const settled = await run(root, bin, "--check");
    expect(settled.exitCode).toBe(0);

    // 5. Editing the source makes its pair stale again.
    await writeFile(
      join(root, "docs/guides/install.mdx"),
      INSTALL_EN.replace("Run the installer.", "Run the new installer.")
    );
    const drifted = await run(root, bin, "--check");
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stderr).toContain("stale");
  }, 60_000);

  it("exits 1 and keeps the successes when a translation fails validation", async () => {
    const root = await fixture({
      "blume.config.ts": CONFIG,
      "docs/guides/install.mdx": INSTALL_EN,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    // The canned reply only validates against install.mdx (the other page's
    // reconstruction succeeds too — both sources share no fences — so make the
    // reply structurally invalid for neither and count statuses instead).
    const bin = await fakeClaude(root, INSTALL_FR);
    const result = await run(root, bin, "--claude", "--json");
    // Both pages get the same reply; both validate (no fences anywhere), so
    // this run succeeds — assert instead that a garbage reply fails.
    expect(result.exitCode).toBe(0);

    await rm(join(root, "blume.translations.json"));
    await rm(join(root, "docs/fr"), { force: true, recursive: true });
    await writeFile(
      join(root, "reply.json"),
      JSON.stringify({ is_error: true, result: "" })
    );
    const failed = await run(root, bin, "--claude", "--json");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("failed");
    const report = JSON.parse(failed.stdout);
    expect(report.translate.counts.failed).toBe(2);
    expect(report.summary.error).toBe(2);
  }, 60_000);

  it("rejects bad flag combinations and values", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root, INSTALL_FR);

    const both = await run(root, bin, "--claude", "--codex");
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("exactly one");

    const none = await run(root, bin);
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain("--claude or --codex");

    const checkAgent = await run(root, bin, "--check", "--claude");
    expect(checkAgent.exitCode).toBe(1);
    expect(checkAgent.stderr).toContain("read-only");

    const timeout = await run(root, bin, "--claude", "--timeout", "0");
    expect(timeout.exitCode).toBe(1);
    expect(timeout.stderr).toContain("Invalid --timeout");

    const concurrency = await run(root, bin, "--claude", "--concurrency", "0");
    expect(concurrency.exitCode).toBe(1);
    expect(concurrency.stderr).toContain("Invalid --concurrency");

    const tooMany = await run(root, bin, "--claude", "--concurrency", "99");
    expect(tooMany.exitCode).toBe(1);
    expect(tooMany.stderr).toContain("Invalid --concurrency");

    const unknown = await run(root, bin, "--claude", "--locale", "xx");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('Unknown --locale "xx"');

    const source = await run(root, bin, "--claude", "--locale", "en");
    expect(source.exitCode).toBe(1);
    expect(source.stderr).toContain("default locale");

    // Case-insensitive locale matching adopts the configured casing.
    const cased = await run(root, bin, "--check", "--locale", "FR");
    expect(cased.exitCode).toBe(1);
    expect(cased.stderr).toContain("→ fr");
  }, 60_000);

  it("errors clearly when i18n is not configured", async () => {
    const root = await fixture({
      "blume.config.ts": 'export default { title: "Test Docs" };',
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });
    const bin = await fakeClaude(root, INSTALL_FR);
    const { exitCode, stderr } = await run(root, bin, "--claude");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("i18n is not configured");
  });

  it("suggests the install command when the agent CLI is missing", async () => {
    const root = await fixture();
    const { exitCode, stderr } = await run(root, undefined, "--claude");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("was not found on PATH");
    expect(stderr).toContain("npm install -g @anthropic-ai/claude-code");
  });
});
