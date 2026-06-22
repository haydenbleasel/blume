import { readFileSync } from "node:fs";

import { dirname, join } from "pathe";

const pkgPath = join(dirname(import.meta.filename), "..", "..", "package.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

/** The installed Blume package version. */
export const BLUME_VERSION = pkg.version;
