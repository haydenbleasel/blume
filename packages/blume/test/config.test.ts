import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { defineConfig, loadConfig } from "../src/core/config.ts";
import { BlumeError } from "../src/core/diagnostics.ts";

const dirs: string[] = [];

const makeDir = async (configSource?: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-config-"));
  dirs.push(dir);
  if (configSource !== undefined) {
    await writeFile(join(dir, "blume.config.ts"), configSource);
  }
  return dir;
};

const loadError = async (dir: string): Promise<BlumeError> => {
  try {
    await loadConfig(dir);
  } catch (error) {
    return error as BlumeError;
  }
  throw new Error("expected loadConfig to throw");
};

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("defineConfig", () => {
  it("returns the config unchanged (typed identity)", () => {
    const config = { title: "Docs" };
    expect(defineConfig(config)).toBe(config);
  });
});

describe("loadConfig", () => {
  it("falls back to schema defaults when no config file exists", async () => {
    const result = await loadConfig(await makeDir());
    expect(result.configFile).toBeNull();
    expect(result.config.title).toBe("Documentation");
    expect(result.diagnostics).toStrictEqual([]);
  });

  it("loads and validates a config module", async () => {
    const dir = await makeDir('export default { title: "My Docs" };');
    const result = await loadConfig(dir);
    expect(result.config.title).toBe("My Docs");
    expect(result.configFile).toBe(join(dir, "blume.config.ts"));
  });

  it("throws a BlumeError for an invalid config", async () => {
    const dir = await makeDir("export default { title: 123 };");
    const error = await loadError(dir);
    expect(error).toBeInstanceOf(BlumeError);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
  });

  it("throws a BlumeError when the config module fails to load", async () => {
    const dir = await makeDir('throw new Error("boom");');
    const error = await loadError(dir);
    expect(error).toBeInstanceOf(BlumeError);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_LOAD_FAILED");
  });
});
