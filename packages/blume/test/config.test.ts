import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { AstroIntegration } from "astro";
import { join } from "pathe";

import { defineConfig, loadConfig } from "../src/core/config.ts";
import { BlumeError } from "../src/core/diagnostics.ts";

const dirs: string[] = [];
const setup = () => {};

type SetupHook = NonNullable<AstroIntegration["hooks"]["astro:config:setup"]>;

const isFunction = (value: SetupHook | undefined): value is SetupHook =>
  typeof value === "function";

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
    // SAFETY: loadConfig only throws BlumeError (load and validation failures
    // are both wrapped), and every fixture passed here triggers one.
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
  it("returns the config and integration instances unchanged", () => {
    const integration = {
      hooks: { "astro:config:setup": setup },
      name: "probe",
    } satisfies AstroIntegration;
    const config = { integrations: [integration], title: "Docs" };

    const defined = defineConfig(config);

    expect(defined).toBe(config);
    expect(defined.integrations?.[0]).toBe(integration);
    expect(defined.integrations?.[0]?.hooks["astro:config:setup"]).toBe(setup);
  });
});

describe("loadConfig", () => {
  it("falls back to schema defaults when no config file exists", async () => {
    const result = await loadConfig(await makeDir());
    expect(result.configFile).toBeNull();
    expect(result.config.title).toBe("Documentation");
    expect(result.config.feedback).toBe(true);
    expect(result.config.integrations).toEqual([]);
    expect(result.diagnostics).toStrictEqual([]);
  });

  it("preserves function-bearing integration instances", async () => {
    const dir = await makeDir(`
      const setup = () => undefined;
      export default {
        integrations: [{ name: "probe", hooks: { "astro:config:setup": setup } }],
      };
    `);
    const result = await loadConfig(dir);
    const [integration] = result.config.integrations;

    expect(integration?.name).toBe("probe");
    expect(isFunction(integration?.hooks["astro:config:setup"])).toBe(true);
  });

  it("rejects a navigation.repo string that is not an absolute URL", async () => {
    // A forgotten scheme (`github.com/acme`) would render as a page-relative
    // link that 404s from every page, so it fails at config time instead.
    const dir = await makeDir(
      'export default { navigation: { repo: "github.com/acme" } };'
    );
    const error = await loadError(dir);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
  });

  it("rejects a non-array integrations value", async () => {
    const dir = await makeDir('export default { integrations: "probe" };');
    const error = await loadError(dir);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
  });

  it("leaves integration element validation to Astro", async () => {
    const dir = await makeDir(
      'export default { integrations: ["not-an-integration"] };'
    );
    const result = await loadConfig(dir);
    // SAFETY: Blume only validates the array boundary; an invalid element
    // passes through unchanged for Astro to reject, so the resolved
    // `AstroIntegration[]` really holds the raw string at runtime.
    expect(result.config.integrations as unknown[]).toEqual([
      "not-an-integration",
    ]);
  });

  it("lets the page-feedback rating be disabled", async () => {
    const dir = await makeDir("export default { feedback: false };");
    const result = await loadConfig(dir);
    expect(result.config.feedback).toBe(false);
  });

  it("enables the React Compiler by default and lets it be opted out", async () => {
    const on = await loadConfig(await makeDir());
    expect(on.config.react.compiler).toBe(true);
    const dir = await makeDir("export default { react: { compiler: false } };");
    const off = await loadConfig(dir);
    expect(off.config.react.compiler).toBe(false);
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

  it("reports every validation issue in one failing run", async () => {
    // Three mistakes must not take three fix-rerun-fail loops to surface.
    const dir = await makeDir(
      "export default { title: 123, feedback: 5, description: [] };"
    );
    const error = await loadError(dir);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
    expect(error.diagnostic.message).toContain("more config issue");
  });

  // A dependency-free Standard Schema, so the temp config needs no imports.
  const OWNER_SCHEMA = `const owner = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        typeof value === "string"
          ? { value }
          : { issues: [{ message: "must be a string" }] },
    },
  };`;

  it("accepts frontmatter.extend schemas via the ~standard contract", async () => {
    const dir = await makeDir(
      `${OWNER_SCHEMA}
export default { frontmatter: { extend: { owner } } };`
    );
    const result = await loadConfig(dir);
    expect(Object.keys(result.config.frontmatter.extend)).toStrictEqual([
      "owner",
    ]);
  });

  it("rejects a frontmatter.extend value that is not a schema", async () => {
    const dir = await makeDir(
      'export default { frontmatter: { extend: { owner: "string" } } };'
    );
    const error = await loadError(dir);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
    expect(error.diagnostic.message).toContain("Standard Schema");
  });

  it("rejects redeclaring a built-in frontmatter field via extend", async () => {
    const dir = await makeDir(
      `${OWNER_SCHEMA}
export default { frontmatter: { extend: { title: owner } } };`
    );
    const error = await loadError(dir);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
    expect(error.diagnostic.message).toContain("built-in frontmatter field");
  });

  it("accepts per-type frontmatter schemas under content.types", async () => {
    const dir = await makeDir(
      `${OWNER_SCHEMA}
export default { content: { types: { rfc: { frontmatter: { owner } } } } };`
    );
    const result = await loadConfig(dir);
    expect(
      Object.keys(result.config.content.types.rfc?.frontmatter ?? {})
    ).toStrictEqual(["owner"]);
  });

  it("rejects redeclaring a built-in frontmatter field via content.types", async () => {
    const dir = await makeDir(
      `${OWNER_SCHEMA}
export default { content: { types: { rfc: { frontmatter: { title: owner } } } } };`
    );
    const error = await loadError(dir);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
    expect(error.diagnostic.message).toContain("built-in frontmatter field");
  });

  it("accepts facets naming declared per-type or site-wide keys", async () => {
    const dir = await makeDir(
      `${OWNER_SCHEMA}
export default {
  content: { types: { rfc: { facets: ["status", "owner"], frontmatter: { status: owner } } } },
  frontmatter: { extend: { owner } },
};`
    );
    const result = await loadConfig(dir);
    expect(result.config.content.types.rfc?.facets).toStrictEqual([
      "status",
      "owner",
    ]);
  });

  it("rejects a facet that is not a declared custom key", async () => {
    const dir = await makeDir(
      `${OWNER_SCHEMA}
export default { content: { types: { rfc: { facets: ["status"], frontmatter: { owner } } } } };`
    );
    const error = await loadError(dir);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
    expect(error.diagnostic.message).toContain(
      "not a declared custom frontmatter key"
    );
  });

  it("rejects a key declared in both frontmatter.extend and a content type", async () => {
    const dir = await makeDir(
      `${OWNER_SCHEMA}
export default {
  content: { types: { rfc: { frontmatter: { owner } } } },
  frontmatter: { extend: { owner } },
};`
    );
    const error = await loadError(dir);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
    expect(error.diagnostic.message).toContain(
      "already declared in frontmatter.extend"
    );
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

describe("analytics config", () => {
  it("accepts vercel, posthog, and custom scripts together", async () => {
    const dir = await makeDir(
      'export default { analytics: { vercel: true, posthog: { key: "phc_test" }, scripts: [{ src: "https://plausible.io/js/script.js", strategy: "defer", attributes: { "data-domain": "example.com" } }] } };'
    );
    const result = await loadConfig(dir);
    expect(result.config.analytics?.vercel).toBe(true);
    expect(result.config.analytics?.posthog?.key).toBe("phc_test");
    expect(result.config.analytics?.scripts?.[0]?.src).toBe(
      "https://plausible.io/js/script.js"
    );
  });

  it("rejects a script with both src and content", async () => {
    const dir = await makeDir(
      'export default { analytics: { scripts: [{ src: "https://x.test/a.js", content: "noop()" }] } };'
    );
    const error = await loadError(dir);
    expect(error).toBeInstanceOf(BlumeError);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
  });

  it("rejects a script with neither src nor content", async () => {
    const dir = await makeDir(
      'export default { analytics: { scripts: [{ strategy: "defer" }] } };'
    );
    const error = await loadError(dir);
    expect(error).toBeInstanceOf(BlumeError);
    expect(error.diagnostic.code).toBe("BLUME_CONFIG_INVALID");
  });
});
