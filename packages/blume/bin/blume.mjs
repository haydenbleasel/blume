#!/usr/bin/env bun
// Blume CLI launcher.
//
// During development the CLI runs directly from TypeScript source via Bun, which
// transpiles on import. A node-compatible `dist/` build is produced for
// publishing (see the tooling milestone); when present it is preferred.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const built = path.join(here, "..", "dist", "cli", "index.js");
const source = path.join(here, "..", "src", "cli", "index.ts");

const entry = existsSync(built) ? built : source;

await import(pathToFileURL(entry).href);
