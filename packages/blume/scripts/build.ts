#!/usr/bin/env bun
// Build the Node-runnable CLI and the public-API type declarations into dist/.
//
// Blume ships its Astro runtime (components, theme, integration, markdown
// processors) as source: the consumer's Astro/Vite pipeline compiles those, and
// Tailwind's `@source` scans the package's component source for class names. The
// only code that runs *outside* a transpiler is the CLI entry, so that is the
// only thing that needs bundling to plain JS for Node.
//
// Bun bundles src/cli/index.ts (and its Node-side imports) into dist/cli/: the
// entry at dist/cli/index.js plus one code-split chunk per lazily loaded command
// (see cli-bundle.ts). Every declared dependency is externalized — those resolve
// from the consumer's install at runtime.
//
// Separately, tsc emits .d.ts for every module in src/ into dist/types/, since
// any of them can be reached through an export (`blume`, `blume/core/*.ts`, the
// generated virtual-module types). Without them a consumer's tsconfig follows
// an export into `src/*.ts` and checks Blume's source under its own compiler
// options (`exactOptionalPropertyTypes`, missing `@types`), errors that
// `skipLibCheck` can't hide. The exports map points the `types` condition at
// these declarations while the runtime keeps resolving to source;
// test/export-types.test.ts fails on a `types` target the build doesn't emit.
// tsgo stays the repo's own typechecker (`bun run typecheck`).
import { rm } from "node:fs/promises";
import path from "node:path";

import { $ } from "bun";

import { cliBundleOptions } from "./cli-bundle.ts";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.resolve(root, "dist");

await rm(dist, { force: true, recursive: true });

const result = await Bun.build(cliBundleOptions(dist));

if (!result.success) {
  for (const log of result.logs) {
    console.error(log.message);
  }
  throw new Error("CLI bundle failed");
}

// Emit public-API declarations to dist/types/. `$` resolves tsc from
// node_modules/.bin and throws on a non-zero exit, failing the build.
await $`tsc -p tsconfig.build.json`.cwd(root);

console.log(`build: dist/ ready (${result.outputs.length} file(s) + types)`);
