import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { loadEnvFiles } from "../src/cli/env.ts";

const dirs: string[] = [];
const touched: string[] = [];

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-env-"));
  dirs.push(dir);
  return dir;
};

/** Track a key so it can be cleaned up regardless of what the test set it to. */
const track = (...keys: string[]): void => {
  touched.push(...keys);
};

afterEach(async () => {
  for (const key of touched.splice(0)) {
    Reflect.deleteProperty(process.env, key);
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const load = async (content: string): Promise<string> => {
  const base = await tempDir();
  await mkdir(join(base, ".git"), { recursive: true });
  await writeFile(join(base, ".env"), content, "utf-8");
  loadEnvFiles(base);
  return base;
};

// Parsing itself is dotenv's; these pin the behaviors Blume relies on
// end-to-end through the file loader — the format contract with Vite (which
// parses the identical file with the same library at build time).
describe("loadEnvFiles parsing (dotenv contract)", () => {
  it("parses exports, quotes, comments, and inline equals", async () => {
    track(
      "BLUME_ENVTEST_EXPORTED",
      "BLUME_ENVTEST_DQ",
      "BLUME_ENVTEST_SQ",
      "BLUME_ENVTEST_PLAIN",
      "BLUME_ENVTEST_WITHEQ"
    );
    await load(
      [
        "# a comment",
        "",
        "export BLUME_ENVTEST_EXPORTED=yes",
        'BLUME_ENVTEST_DQ="line\\nbreak"',
        "BLUME_ENVTEST_SQ='raw\\nvalue'",
        "BLUME_ENVTEST_PLAIN=hello world",
        "BLUME_ENVTEST_WITHEQ=a=b",
        "not a valid line",
      ].join("\n")
    );
    expect(process.env.BLUME_ENVTEST_EXPORTED).toBe("yes");
    expect(process.env.BLUME_ENVTEST_DQ).toBe("line\nbreak");
    expect(process.env.BLUME_ENVTEST_SQ).toBe("raw\\nvalue");
    expect(process.env.BLUME_ENVTEST_PLAIN).toBe("hello world");
    expect(process.env.BLUME_ENVTEST_WITHEQ).toBe("a=b");
  });

  it("keeps a multi-line double-quoted value intact (PEM keys)", async () => {
    // The reason parsing goes through dotenv: a line-based parser truncates
    // this at the first newline and hands consumers a corrupt credential.
    track("BLUME_ENVTEST_SIGNING_KEY", "BLUME_ENVTEST_AFTER");
    const key = [
      "-----BEGIN PRIVATE KEY-----",
      "abc123",
      "def456",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    await load(`BLUME_ENVTEST_SIGNING_KEY="${key}"\nBLUME_ENVTEST_AFTER=ok\n`);
    expect(process.env.BLUME_ENVTEST_SIGNING_KEY).toBe(key);
    expect(process.env.BLUME_ENVTEST_AFTER).toBe("ok");
  });

  it("strips unquoted inline comments, like dotenv and Vite", async () => {
    track("BLUME_ENVTEST_TOKEN", "BLUME_ENVTEST_KEPT", "BLUME_ENVTEST_KEPT_SQ");
    await load(
      [
        "BLUME_ENVTEST_TOKEN=ghp_abc123 # personal token",
        'BLUME_ENVTEST_KEPT="value # not a comment"',
        "BLUME_ENVTEST_KEPT_SQ='value # not a comment'",
      ].join("\n")
    );
    expect(process.env.BLUME_ENVTEST_TOKEN).toBe("ghp_abc123");
    expect(process.env.BLUME_ENVTEST_KEPT).toBe("value # not a comment");
    expect(process.env.BLUME_ENVTEST_KEPT_SQ).toBe("value # not a comment");
  });
});

describe("loadEnvFiles", () => {
  it("cascades to the repo root, letting nearer files and the shell win", async () => {
    const base = await tempDir();
    const repo = join(base, "outer", "repo");
    const app = join(repo, "app");
    await mkdir(app, { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(base, "outer", ".env"), "BLUME_ENVTEST_OUTER=above\n");
    await writeFile(
      join(repo, ".env"),
      "BLUME_ENVTEST_BASE=base\nBLUME_ENVTEST_SHARED=fromenv\n"
    );
    await writeFile(
      join(repo, ".env.local"),
      "BLUME_ENVTEST_LOCAL=local\nBLUME_ENVTEST_SHARED=fromlocal\n"
    );
    await writeFile(
      join(app, ".env"),
      "BLUME_ENVTEST_APP=app\nBLUME_ENVTEST_PREEXIST=fromfile\n"
    );

    track(
      "BLUME_ENVTEST_OUTER",
      "BLUME_ENVTEST_BASE",
      "BLUME_ENVTEST_SHARED",
      "BLUME_ENVTEST_LOCAL",
      "BLUME_ENVTEST_APP",
      "BLUME_ENVTEST_PREEXIST"
    );
    process.env.BLUME_ENVTEST_PREEXIST = "shell";

    loadEnvFiles(app);

    expect(process.env.BLUME_ENVTEST_APP).toBe("app");
    expect(process.env.BLUME_ENVTEST_LOCAL).toBe("local");
    expect(process.env.BLUME_ENVTEST_BASE).toBe("base");
    // `.env.local` layers over `.env` within a dir.
    expect(process.env.BLUME_ENVTEST_SHARED).toBe("fromlocal");
    // The `.git` in repo/ stops the walk before outer/.env.
    expect(process.env.BLUME_ENVTEST_OUTER).toBeUndefined();
    // An existing (shell) value is never clobbered.
    expect(process.env.BLUME_ENVTEST_PREEXIST).toBe("shell");
  });

  it("walks to the filesystem root when there is no repo marker", async () => {
    const base = await tempDir();
    await writeFile(join(base, ".env"), "BLUME_ENVTEST_ROOTWALK=walked\n");
    track("BLUME_ENVTEST_ROOTWALK");

    loadEnvFiles(base);

    expect(process.env.BLUME_ENVTEST_ROOTWALK).toBe("walked");
  });

  it("ignores an unreadable env file without throwing", async () => {
    const base = await tempDir();
    await mkdir(join(base, ".git"), { recursive: true });
    // A directory named `.env` exists but cannot be read as a file.
    await mkdir(join(base, ".env"), { recursive: true });

    expect(() => loadEnvFiles(base)).not.toThrow();
  });
});
