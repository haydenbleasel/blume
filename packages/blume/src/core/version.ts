import { readFileSync } from "node:fs";

import { join } from "pathe";

import { packageRoot } from "./package-root.ts";

let cached: string | undefined;

/**
 * The installed Blume package version, read lazily from its `package.json`.
 *
 * Computed on demand (not at module load) so importing the `blume` barrel has no
 * filesystem side effect, and anchored at the package root so it resolves the
 * same whether running from source or the bundled CLI.
 */
export const getBlumeVersion = (): string => {
  if (cached === undefined) {
    const pkgPath = join(packageRoot(), "package.json");
    // SAFETY: this reads blume's own package.json, which always declares a
    // `version` (publishing requires it).
    cached = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string })
      .version;
  }
  return cached;
};
