import { createJiti } from "jiti";

/**
 * Create a loader for user-authored ESM/TS modules (`blume.config.ts`,
 * `meta.ts`). One jiti instance is reused across every file the returned loader
 * is called with. `moduleCache: false` ensures edits are picked up on each load,
 * which is what makes dev-server regeneration reflect config/meta changes.
 */
export const createModuleLoader = (): ((file: string) => Promise<unknown>) => {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return async (file: string) => {
    const loaded = await jiti.import<{ default?: unknown }>(file);
    return loaded?.default ?? loaded;
  };
};
