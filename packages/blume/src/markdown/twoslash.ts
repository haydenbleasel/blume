/**
 * The Twoslash transformer for fenced code blocks, compiled with Blume's own
 * pinned TypeScript instead of whatever copy the user's project hoists.
 *
 * The stock `transformerTwoslash` from `@shikijs/twoslash` resolves the
 * ambient `typescript` package, which is whatever version the surrounding
 * project installed. Under TypeScript 7 (the native tsgo compiler) the
 * package's main export is a version stub with no classic compiler API — no
 * `ts.sys`, no language service — and its `lib/` directory ships no
 * `lib.*.d.ts` files, so Twoslash breaks the moment a fence uses it. Blume
 * ships a classic `typescript` as its own runtime dependency, so this factory
 * resolves that copy from inside the package and hands it to Twoslash
 * explicitly (`tsModule` for the compiler, `tsLibDirectory` for the default
 * lib files), leaving the user's project free to use any TypeScript version.
 *
 * Composed from the `core` entrypoints of both packages: the main `twoslash`
 * entry eagerly imports the ambient `typescript` (harmless under TS7 — the
 * stub loads fine — but pointless), and its `transformerTwoslash` wrapper
 * forwards `tsModule` to `createTwoslasher` while dropping `tsLibDirectory`.
 * The core entries import no `typescript` at all and take both options.
 */

import { createRequire } from "node:module";
import path from "node:path";

import { createTransformerFactory, rendererRich } from "@shikijs/twoslash/core";
import type { ShikiTransformer } from "shiki";
import { createTwoslasher } from "twoslash/core";
import type TS from "typescript";

const require = createRequire(import.meta.url);

/**
 * Twoslash transformer preconfigured for Blume: opt-in per fence via the
 * `twoslash` meta keyword (explicitTrigger), compiling with Blume's own
 * pinned classic TypeScript. The compiler is resolved lazily at call time —
 * this runs once, at Astro config load — so merely importing this module
 * never pays the TypeScript parse cost.
 */
export const blumeTwoslashTransformer = (): ShikiTransformer => {
  const tsModule = require("typescript") as typeof TS;
  const twoslasher = createTwoslasher({
    // Match the stock transformer's default: fence snippets are authored
    // bundler-style (extensionless relative imports, package imports).
    compilerOptions: {
      moduleResolution: tsModule.ModuleResolutionKind.Bundler,
    },
    // `require.resolve("typescript")` is the package's main entry,
    // `lib/typescript.js`; its directory holds the `lib.*.d.ts` default libs.
    tsLibDirectory: path.dirname(require.resolve("typescript")),
    tsModule,
    vfsRoot: process.cwd(),
  });
  return createTransformerFactory(
    twoslasher,
    rendererRich()
  )({
    explicitTrigger: true,
  });
};
