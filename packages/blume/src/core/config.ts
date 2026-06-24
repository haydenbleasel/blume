import { createJiti } from "jiti";

import { BlumeError, diagnosticsFromZod } from "./diagnostics.ts";
import { loadMintlifyConfig } from "./mintlify.ts";
import { findBlumeConfigFile, findMintlifyConfigFile } from "./project.ts";
import { blumeConfigSchema } from "./schema.ts";
import type { BlumeConfig, ResolvedConfig } from "./schema.ts";
import type { Diagnostic } from "./types.ts";

/**
 * Identity helper for authoring `blume.config.ts`. Exists for type inference
 * and a stable future home for plugin hooks; it does not transform input.
 */
export const defineConfig = (config: BlumeConfig): BlumeConfig => config;

/** Result of loading + validating a project config. */
export interface ConfigLoadResult {
  config: ResolvedConfig;
  /** Absolute path of the config file used, or null when defaults were used. */
  configFile: string | null;
  diagnostics: Diagnostic[];
}

const importConfigModule = async (file: string): Promise<unknown> => {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const loaded = await jiti.import<{ default?: unknown }>(file);
  return loaded?.default ?? loaded;
};

/**
 * Load and validate the project config. When no config file exists, schema
 * defaults produce a fully resolved config so the zero-boilerplate path works.
 */
export const loadConfig = async (root: string): Promise<ConfigLoadResult> => {
  const blumeConfigFile = findBlumeConfigFile(root);
  const mintlifyConfigFile = blumeConfigFile
    ? null
    : findMintlifyConfigFile(root);
  const configFile = blumeConfigFile ?? mintlifyConfigFile;

  let raw: unknown = {};
  if (blumeConfigFile) {
    try {
      raw = await importConfigModule(blumeConfigFile);
    } catch (error) {
      throw new BlumeError({
        code: "BLUME_CONFIG_LOAD_FAILED",
        file: blumeConfigFile,
        message: `Failed to load config: ${(error as Error).message}`,
        severity: "error",
      });
    }
  } else if (mintlifyConfigFile) {
    raw = await loadMintlifyConfig(root, mintlifyConfigFile);
  }

  const parsed = blumeConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const diagnostics = diagnosticsFromZod(parsed.error, {
      code: "BLUME_CONFIG_INVALID",
      file: configFile ?? undefined,
    });
    throw new BlumeError(
      diagnostics[0] ?? {
        code: "BLUME_CONFIG_INVALID",
        file: configFile ?? undefined,
        message: "Invalid Blume config.",
        severity: "error",
      }
    );
  }

  return {
    config: parsed.data,
    configFile,
    diagnostics: [],
  };
};
