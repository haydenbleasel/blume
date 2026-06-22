#!/usr/bin/env bun
// Blume CLI launcher.
//
// During development the CLI runs directly from TypeScript source via Bun, which
// transpiles on import. A node-compatible `dist/` build is produced for
// publishing (see the tooling milestone); when present it is preferred.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "dist", "cli", "index.js");
const source = join(here, "..", "src", "cli", "index.ts");

const entry = existsSync(built) ? built : source;

await import(pathToFileURL(entry).href);
