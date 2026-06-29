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

  it("enables OG images by default once deployment.site is set", async () => {
    const dir = await makeDir(
      'export default { deployment: { site: "https://example.com" } };'
    );
    const result = await loadConfig(dir);
    expect(result.config.seo.og.enabled).toBe(true);
  });

  it("leaves OG images off by default without deployment.site", async () => {
    const result = await loadConfig(await makeDir());
    expect(result.config.seo.og.enabled).toBe(false);
  });

  it("falls back to the dev server URL for deployment.site (dev only)", async () => {
    const dir = await makeDir();
    const result = await loadConfig(dir, {
      devServerUrl: "http://localhost:4321",
    });
    expect(result.config.deployment.site).toBe("http://localhost:4321");
    // The localhost fallback is a known site URL, so OG turns on with it.
    expect(result.config.seo.og.enabled).toBe(true);
    // No fallback (the build path) leaves the site unset.
    const built = await loadConfig(dir);
    expect(built.config.deployment.site).toBeUndefined();
  });

  it("honors an explicit seo.og.enabled over the site-based default", async () => {
    const offDir = await makeDir(
      'export default { deployment: { site: "https://example.com" }, seo: { og: { enabled: false } } };'
    );
    const off = await loadConfig(offDir);
    expect(off.config.seo.og.enabled).toBe(false);

    const onDir = await makeDir(
      "export default { seo: { og: { enabled: true } } };"
    );
    const on = await loadConfig(onDir);
    expect(on.config.seo.og.enabled).toBe(true);
  });
});
