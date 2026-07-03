import { existsSync, readFileSync } from "node:fs";

import { detectMintlifyBridge } from "./bridge.ts";
import type { BridgeDetection } from "./bridge.ts";
import { applyDeploymentEnv } from "./deployment-env.ts";
import { BlumeError, diagnosticsFromZod } from "./diagnostics.ts";
import { createModuleLoader } from "./load-module.ts";
import { findConfigFile } from "./project.ts";
import { blumeConfigSchema } from "./schema.ts";
import type { BlumeConfig, ResolvedConfig } from "./schema.ts";
import type { Diagnostic } from "./types.ts";

/**
 * Identity helper for authoring `blume.config.ts`. Exists for type inference
 * and a stable future home for plugin hooks; it does not transform input.
 */
export const defineConfig = (config: BlumeConfig): BlumeConfig => config;

/** Bridge mode info: a foreign docs tool Blume is serving without migrating. */
export interface ConfigBridge {
  tool: "mintlify";
  /** Absolute path of the foreign config file (`docs.json`/`mint.json`). */
  configFile: string;
}

/** Result of loading + validating a project config. */
export interface ConfigLoadResult {
  config: ResolvedConfig;
  /** Absolute path of the config file used, or null when defaults were used. */
  configFile: string | null;
  /** Set when a foreign docs config (e.g. Mintlify) is being bridged. */
  bridge: ConfigBridge | null;
  diagnostics: Diagnostic[];
}

const importConfigModule = createModuleLoader();

/**
 * Load and validate the project config. When no config file exists, schema
 * defaults produce a fully resolved config so the zero-boilerplate path works.
 */
export const loadConfig = async (
  root: string,
  /**
   * Supplied only by `blume dev`: the local dev server URL, used as the
   * `deployment.site` fallback when none is configured or detected. Builds
   * never pass it, so production output can't end up pointing at localhost.
   */
  options: { devServerUrl?: string } = {}
): Promise<ConfigLoadResult> => {
  const configFile = findConfigFile(root);

  // With no Blume config, a Mintlify `docs.json` activates bridge mode: serve
  // the unconverted project by synthesizing config + a `mintlify` content source.
  let bridge: BridgeDetection | null = null;
  let raw: unknown = {};
  if (configFile) {
    try {
      raw = await importConfigModule(configFile);
    } catch (error) {
      throw new BlumeError({
        code: "BLUME_CONFIG_LOAD_FAILED",
        file: configFile,
        message: `Failed to load config: ${(error as Error).message}`,
        severity: "error",
      });
    }
  } else {
    bridge = await detectMintlifyBridge(root);
    if (bridge) {
      ({ raw } = bridge);
    }
  }

  const sourceFile = bridge?.configFile ?? configFile;
  const parsed = blumeConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    // Read the raw config text (when on disk) so errors carry a line/column.
    const source =
      sourceFile && existsSync(sourceFile)
        ? readFileSync(sourceFile, "utf-8")
        : undefined;
    const diagnostics = diagnosticsFromZod(parsed.error, {
      code: "BLUME_CONFIG_INVALID",
      file: sourceFile ?? undefined,
      source,
    });
    const [first, ...rest] = diagnostics;
    const primary = first ?? {
      code: "BLUME_CONFIG_INVALID",
      file: sourceFile ?? undefined,
      message: "Invalid Blume config.",
      severity: "error" as const,
    };
    // Surface every issue in one failing run — reporting only the first turns
    // a three-mistake config into three fix-rerun-fail loops.
    throw new BlumeError(
      rest.length > 0
        ? {
            ...primary,
            message: `${primary.message}\n${rest.length} more config issue(s):\n${rest.map((d) => `  - ${d.message}`).join("\n")}`,
          }
        : primary
    );
  }

  // Resolve the canonical site URL, then SEO defaults that depend on it.
  // Precedence: explicit config > platform env (Vercel/Netlify/Cloudflare, via
  // applyDeploymentEnv) > the local dev server URL (dev only).
  const config = applyDeploymentEnv(parsed.data);
  const site = config.deployment.site ?? options.devServerUrl;

  // OG images need an absolute `og:image`, so they default on once a site URL
  // is known and off otherwise. An explicit `seo.og.enabled` always wins.
  const ogEnabled = config.seo.og.enabled ?? Boolean(site);

  return {
    bridge: bridge
      ? { configFile: bridge.configFile, tool: bridge.tool }
      : null,
    config: {
      ...config,
      deployment: { ...config.deployment, site },
      seo: { ...config.seo, og: { ...config.seo.og, enabled: ogEnabled } },
    },
    configFile: sourceFile,
    diagnostics: [],
  };
};
