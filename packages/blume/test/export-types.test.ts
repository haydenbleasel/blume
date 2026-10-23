import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { join, normalize, relative } from "pathe";
import ts from "typescript";
import { z } from "zod";

import { packageRoot } from "../src/core/package-root.ts";

// Every module a consumer can import through Blume's `exports` must type from
// an emitted declaration. When a `types` target doesn't exist, TypeScript
// silently falls back to `default` (Blume's `.ts` source) and checks it under
// the consumer's compiler options, where `exactOptionalPropertyTypes` alone
// reports hundreds of errors that `skipLibCheck` can't hide. The suite needs no
// build: it lists what `tsconfig.build.json` emits and resolves each specifier
// with TypeScript's own resolver against that list.

const root = packageRoot();

/** Each export reduced to the file it runs from, as `core/load-module.ts` reads it. */
const exportsSchema = z.object({
  exports: z.record(
    z.string(),
    z.union([
      z.string(),
      z.object({ default: z.string() }).transform((target) => target.default),
    ])
  ),
});

const { exports } = exportsSchema.parse(
  JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))
);

const DECLARATION_SOURCE = /(?<!\.d)\.tsx?$/u;

/**
 * The `.d.ts` files `tsconfig.build.json` writes to `dist/types/`: one per
 * source file in its program, the configured roots and everything they import.
 */
const emitted = (): Set<string> => {
  const configPath = join(root, "tsconfig.build.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { fileNames, options } = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    root
  );
  const src = join(root, "src");
  return new Set(
    ts
      .createProgram(fileNames, options)
      .getSourceFiles()
      .map((file) => normalize(file.fileName))
      .filter((file) => file.startsWith(`${src}/`))
      .filter((file) => DECLARATION_SOURCE.test(file))
      .map((file) =>
        join(
          root,
          "dist/types",
          relative(src, file).replace(DECLARATION_SOURCE, ".d.ts")
        )
      )
  );
};

/**
 * Each `blume/...` specifier that reaches a TypeScript module through an
 * export: the entry itself, or one specifier per `.ts`/`.tsx` file a wildcard
 * entry matches on disk.
 */
const specifiers = (): Set<string> =>
  new Set(
    Object.entries(exports).flatMap(([subpath, source]) => {
      if (!source.includes("*")) {
        return DECLARATION_SOURCE.test(source) ? [join("blume", subpath)] : [];
      }
      const [prefix = "", suffix = ""] = source.split("*");
      const cwd = join(root, prefix);
      return [...new Bun.Glob(`**/*${suffix}`).scanSync({ cwd })]
        .map((file) => file.replaceAll("\\", "/"))
        .filter((file) => DECLARATION_SOURCE.test(file))
        .map((file) =>
          join(
            "blume",
            subpath.replace("*", file.slice(0, -suffix.length || undefined))
          )
        );
    })
  );

describe("export declarations", () => {
  it("types every module reachable through an export from dist/types", () => {
    const declarations = emitted();
    const host: ts.ModuleResolutionHost = {
      ...ts.sys,
      fileExists: (file) =>
        declarations.has(normalize(file)) || ts.sys.fileExists(file),
    };
    const options: ts.CompilerOptions = {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    // Resolving from inside the package uses its self-reference, so the
    // `exports` map applies exactly as it does from a consumer's node_modules.
    const from = join(root, "src/index.ts");

    const all = [...specifiers()];
    const untyped = all.filter((specifier) => {
      const resolved = ts.resolveModuleName(specifier, from, options, host)
        .resolvedModule?.resolvedFileName;
      return !(resolved && declarations.has(normalize(resolved)));
    });

    expect(all).toContain("blume/core/content.ts");
    expect(all).toContain("blume/components/islands/assistant.tsx");
    expect(untyped).toEqual([]);
  });
});
