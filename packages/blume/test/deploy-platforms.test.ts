import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { checkRequiredSecrets } from "../src/cli/required-secrets.ts";
import type { JsonValue } from "../src/core/adapter.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  cloudflare,
  netlify,
  node,
  vercel,
} from "../src/deploy/adapters/index.ts";
import type { DeployAdapterKind } from "../src/deploy/adapters/index.ts";
import { NEGOTIATION_WORKER_FILE } from "../src/deploy/cloudflare-negotiation.ts";
import {
  cloudflarePlatform,
  emitCloudflareNegotiation,
} from "../src/deploy/platforms/cloudflare.ts";
import {
  DEPLOY_PLATFORMS,
  deployPlatform,
} from "../src/deploy/platforms/index.ts";
import type { BuildLog } from "../src/deploy/platforms/index.ts";
import { staticPlatform } from "../src/deploy/platforms/static.ts";
import {
  checkVercelFunctionBundles,
  emitVercelNegotiation,
  vercelPlatform,
} from "../src/deploy/platforms/vercel.ts";

/**
 * The deployment adapters and the platform behaviors behind them: what the
 * factories return, how the schema resolves and rejects them, and the
 * post-build hooks the build command runs through `finalizeBuild`.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const writeTree = async (
  root: string,
  files: Record<string, string>
): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    })
  );
};

/**
 * A scanned project on the given adapter, inlined as JSON into its config,
 * with any other config entries appended verbatim.
 */
const project = async (
  deployment: string,
  files: Record<string, string> = {},
  config = ""
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-platform-"));
  dirs.push(root);
  await writeTree(root, {
    "blume.config.ts": `export default { deployment: ${deployment}${config} };\n`,
    "docs/index.md": "# Home\n\nWelcome.\n",
    "docs/intro.md": "# Intro\n\nHello.\n",
    ...files,
  });
  return scanProject(root, { mode: "build" });
};

interface Recorded {
  error: string[];
  info: string[];
  success: string[];
  warn: string[];
}

interface Recorder {
  log: BuildLog;
  recorded: Recorded;
}

const recorder = (): Recorder => {
  const recorded: Recorded = { error: [], info: [], success: [], warn: [] };
  return {
    log: {
      error: (message) => recorded.error.push(message),
      info: (message) => recorded.info.push(message),
      success: (message) => recorded.success.push(message),
      warn: (message) => recorded.warn.push(message),
    },
    recorded,
  };
};

/** Parse a `deployment` value the way the config loader would, as plain JSON. */
const parseDeployment = (deployment: JsonValue) =>
  blumeConfigSchema.safeParse({ deployment });

describe("deployment adapter factories", () => {
  it("return plain descriptors that declare their adapter package", () => {
    expect(vercel()).toEqual({
      kind: "vercel",
      options: {},
      requiredSecrets: [],
      runtimeDeps: ["@astrojs/vercel"],
    });
    expect(netlify().runtimeDeps).toEqual(["@astrojs/netlify"]);
    expect(cloudflare().runtimeDeps).toEqual(["@astrojs/cloudflare"]);
    expect(node().runtimeDeps).toEqual(["@astrojs/node"]);
  });

  it("declare no adapter package for a static build on the host", () => {
    expect(netlify({ output: "static" }).runtimeDeps).toEqual([]);
  });

  it("keep every option verbatim", () => {
    const adapter = vercel({ isr: { expiration: 60 }, site: "https://x.dev" });
    expect(adapter.options).toEqual({
      isr: { expiration: 60 },
      site: "https://x.dev",
    });
  });
});

describe("deployment schema", () => {
  it("resolves an unset deployment to a static build", () => {
    const { deployment } = blumeConfigSchema.parse({});
    expect(deployment).toEqual({
      kind: "static",
      options: { output: "static" },
      requiredSecrets: [],
      runtimeDeps: [],
    });
  });

  it("resolves the plain { site, base } form to the static kind", () => {
    const { deployment } = blumeConfigSchema.parse({
      deployment: { base: "/docs", site: "https://docs.example.com" },
    });
    expect(deployment.kind).toBe("static");
    expect(deployment.options).toEqual({
      base: "/docs",
      output: "static",
      site: "https://docs.example.com",
    });
  });

  it("defaults a host adapter to server output and keeps its passthrough", () => {
    const { deployment } = blumeConfigSchema.parse({
      deployment: vercel({ isr: true }),
    });
    expect(deployment).toEqual({
      kind: "vercel",
      options: { isr: true, output: "server" },
      requiredSecrets: [],
      runtimeDeps: ["@astrojs/vercel"],
    });
  });

  it("keeps a host adapter's static output and drops its runtime dep", () => {
    const { deployment } = blumeConfigSchema.parse({
      deployment: cloudflare({ output: "static" }),
    });
    expect(deployment.kind).toBe("cloudflare");
    expect(deployment.options.output).toBe("static");
    expect(deployment.runtimeDeps).toEqual([]);
  });

  it("re-derives metadata from the factory for a descriptor that went through JSON", () => {
    const { deployment } = blumeConfigSchema.parse({
      deployment: { ...netlify(), runtimeDeps: ["tampered"] },
    });
    expect(deployment.runtimeDeps).toEqual(["@astrojs/netlify"]);
  });

  it("rejects the 1.x adapter/output object with the adapter hint", () => {
    const result = parseDeployment({ adapter: "vercel", output: "server" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('"blume/deploy"');
  });

  it("rejects a bare adapter name with the adapter hint", () => {
    const result = parseDeployment("vercel");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('"blume/deploy"');
  });

  it("rejects an unknown kind with the adapter hint", () => {
    const result = parseDeployment({ ...vercel(), kind: "aws" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('"blume/deploy"');
  });

  it("keeps an option error's own path and message", () => {
    const result = parseDeployment({ ...vercel({ site: "not a url" }) });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(["deployment", "options", "site"]);
    expect(issue?.message).not.toContain("blume/deploy");
  });
});

describe("deployPlatform", () => {
  it("looks every kind up by its descriptor", () => {
    for (const platform of DEPLOY_PLATFORMS) {
      expect(deployPlatform({ kind: platform.kind })).toBe(platform);
    }
  });

  it("refuses a kind no platform owns", () => {
    // SAFETY: the guard under test is exactly the one the type forbids.
    const kind = "aws" as DeployAdapterKind;
    expect(() => deployPlatform({ kind })).toThrow('adapter "aws"');
  });

  it("writes every platform's redirect file for a static build on no host", () => {
    expect(staticPlatform.redirectFiles.map((file) => file.name)).toEqual([
      "_redirects",
      "vercel.json",
    ]);
    expect(deployPlatform(node()).redirectFiles).toEqual([]);
  });
});

describe("checkRequiredSecrets for a deployment", () => {
  it("requires the secrets the adapter declares", () => {
    const config = blumeConfigSchema.parse({ deployment: node() });
    Reflect.deleteProperty(process.env, "BLUME_TEST_DEPLOY_TOKEN");
    const result = checkRequiredSecrets({
      ...config,
      deployment: {
        ...config.deployment,
        requiredSecrets: ["BLUME_TEST_DEPLOY_TOKEN"],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain("Deployment (node)");
    expect(result[0]?.message).toContain("BLUME_TEST_DEPLOY_TOKEN");
  });
});

/** A public Ed25519 JWK, the one key type Web Bot Auth accepts. */
const ED25519_PUBLIC = {
  crv: "Ed25519",
  kty: "OKP",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};

/** A Build Output config with the filesystem handler the injector needs. */
const VERCEL_CONFIG = JSON.stringify({
  routes: [{ handle: "filesystem" }],
  version: 3,
});

describe("vercel platform", () => {
  it("wires negotiation into the routing config at the project root", async () => {
    const built = await project(JSON.stringify(vercel()), {
      ".vercel/output/config.json": VERCEL_CONFIG,
      ".vercel/output/static/404.md": "# Not found\n",
    });
    const { log, recorded } = recorder();
    await emitVercelNegotiation(built, log);
    expect(recorded.success).toEqual([
      "Wired Accept: text/markdown negotiation into the Vercel routing config",
    ]);
    const config = await readFile(
      join(built.context.root, ".vercel", "output", "config.json"),
      "utf-8"
    );
    expect(config).toContain("text/markdown");
    // The content routes are rewritten to their `.md` mirrors.
    expect(config).toContain('"src": "^(/intro)/?$"');
    expect(config).toContain('"dest": "$1.md"');
  });

  it("overrides the media type of the Web Bot Auth signatures directory", async () => {
    const built = await project(
      JSON.stringify(vercel()),
      { ".vercel/output/config.json": VERCEL_CONFIG },
      `, ai: { webBotAuth: { keys: [${JSON.stringify(ED25519_PUBLIC)}] } }`
    );
    const { log } = recorder();
    await emitVercelNegotiation(built, log);
    const config = await readFile(
      join(built.context.root, ".vercel", "output", "config.json"),
      "utf-8"
    );
    expect(config).toContain('".well-known/http-message-signatures-directory"');
  });

  it("warns and leaves an unreadable routing config alone", async () => {
    const built = await project(JSON.stringify(vercel()), {
      ".vercel/output/config.json": "not json",
    });
    const { log, recorded } = recorder();
    await emitVercelNegotiation(built, log);
    expect(recorded.warn[0]).toContain("Could not wire");
    expect(
      await readFile(
        join(built.context.root, ".vercel", "output", "config.json"),
        "utf-8"
      )
    ).toBe("not json");
  });

  it("does nothing without a routing config", async () => {
    const built = await project(JSON.stringify(vercel()));
    const { log, recorded } = recorder();
    await emitVercelNegotiation(built, log);
    expect(recorded).toEqual({ error: [], info: [], success: [], warn: [] });
  });

  it("fails the build on a function bundle missing one of Blume's own deps", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-platform-"));
    dirs.push(root);
    const outputDir = join(root, ".vercel", "output");
    await writeTree(root, {
      ".vercel/output/functions/_render.func/.vc-config.json": JSON.stringify({
        handler: "dist/server/entry.mjs",
        runtime: "nodejs22.x",
      }),
      ".vercel/output/functions/_render.func/dist/server/entry.mjs":
        'import { z } from "zod";\n',
    });
    const { log, recorded } = recorder();
    expect(await checkVercelFunctionBundles(outputDir, root, log)).toBe(false);
    expect(recorded.error[0]).toContain("zod");
    expect(recorded.warn).toEqual([]);
  });

  it("only warns about a project's own missing import", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-platform-"));
    dirs.push(root);
    const outputDir = join(root, ".vercel", "output");
    await writeTree(root, {
      ".vercel/output/functions/_render.func/.vc-config.json": JSON.stringify({
        handler: "dist/server/entry.mjs",
        runtime: "nodejs22.x",
      }),
      ".vercel/output/functions/_render.func/dist/server/entry.mjs":
        'import { thing } from "some-user-package";\n',
    });
    const { log, recorded } = recorder();
    expect(await checkVercelFunctionBundles(outputDir, root, log)).toBe(true);
    expect(recorded.warn[0]).toContain("some-user-package");
    expect(recorded.error).toEqual([]);
  });

  it("finalizes a real build: audits the bundle, then wires negotiation", async () => {
    const built = await project(JSON.stringify(vercel()), {
      ".vercel/output/config.json": VERCEL_CONFIG,
    });
    const { log, recorded } = recorder();
    expect(
      await vercelPlatform.finalizeBuild?.({
        isolated: false,
        log,
        project: built,
      })
    ).toBe(true);
    expect(recorded.success).toHaveLength(1);
  });

  it("finalizes an isolated build without touching the routing config", async () => {
    const built = await project(JSON.stringify(vercel()), {
      ".vercel/output/config.json": VERCEL_CONFIG,
    });
    const { log, recorded } = recorder();
    expect(
      await vercelPlatform.finalizeBuild?.({
        isolated: true,
        log,
        project: built,
      })
    ).toBe(true);
    expect(recorded.success).toEqual([]);
    expect(
      await readFile(
        join(built.context.root, ".vercel", "output", "config.json"),
        "utf-8"
      )
    ).toBe(VERCEL_CONFIG);
  });

  it("refuses to finalize a build whose bundle would crash", async () => {
    const built = await project(JSON.stringify(vercel()), {
      ".vercel/output/config.json": VERCEL_CONFIG,
      ".vercel/output/functions/_render.func/.vc-config.json": JSON.stringify({
        handler: "dist/server/entry.mjs",
        runtime: "nodejs22.x",
      }),
      ".vercel/output/functions/_render.func/dist/server/entry.mjs":
        'import { z } from "zod";\n',
    });
    const { log, recorded } = recorder();
    expect(
      await vercelPlatform.finalizeBuild?.({
        isolated: false,
        log,
        project: built,
      })
    ).toBe(false);
    // The fatal audit stops the build before negotiation is wired.
    expect(recorded.error).toHaveLength(1);
    expect(recorded.success).toEqual([]);
  });
});

/** The wrangler config `@astrojs/cloudflare` emits, as the injector needs it. */
const WRANGLER_CONFIG = JSON.stringify({
  assets: { binding: "ASSETS", directory: "../client" },
  main: "index.js",
  name: "docs",
});

describe("cloudflare platform", () => {
  it("wires the wrapper Worker into the emitted server bundle", async () => {
    const built = await project(JSON.stringify(cloudflare()), {
      "dist/server/wrangler.json": WRANGLER_CONFIG,
    });
    const { log, recorded } = recorder();
    await emitCloudflareNegotiation(built, log);
    expect(recorded.success).toEqual([
      "Wired Accept: text/markdown negotiation into the Cloudflare Worker",
    ]);
    const serverDir = join(built.context.root, "dist", "server");
    expect(existsSync(join(serverDir, NEGOTIATION_WORKER_FILE))).toBe(true);
    const wrangler = await readFile(join(serverDir, "wrangler.json"), "utf-8");
    expect(wrangler).toContain(NEGOTIATION_WORKER_FILE);
    expect(wrangler).toContain("run_worker_first");
  });

  it("warns when the server bundle has no wrangler config", async () => {
    const built = await project(JSON.stringify(cloudflare()));
    const { log, recorded } = recorder();
    await emitCloudflareNegotiation(built, log);
    expect(recorded.warn[0]).toContain("Could not wire");
  });

  it("warns and leaves an unusable wrangler config alone", async () => {
    const built = await project(JSON.stringify(cloudflare()), {
      "dist/server/wrangler.json": "{}",
    });
    const { log, recorded } = recorder();
    await emitCloudflareNegotiation(built, log);
    expect(recorded.warn[0]).toContain("Could not wire");
    expect(
      await readFile(
        join(built.context.root, "dist", "server", "wrangler.json"),
        "utf-8"
      )
    ).toBe("{}");
  });

  it("finalizes a real build by wiring the Worker, and an isolated one by leaving it", async () => {
    const built = await project(JSON.stringify(cloudflare()), {
      "dist/server/wrangler.json": WRANGLER_CONFIG,
    });
    const isolated = recorder();
    expect(
      await cloudflarePlatform.finalizeBuild?.({
        isolated: true,
        log: isolated.log,
        project: built,
      })
    ).toBe(true);
    expect(isolated.recorded.success).toEqual([]);

    const real = recorder();
    expect(
      await cloudflarePlatform.finalizeBuild?.({
        isolated: false,
        log: real.log,
        project: built,
      })
    ).toBe(true);
    expect(real.recorded.success).toHaveLength(1);
  });
});
