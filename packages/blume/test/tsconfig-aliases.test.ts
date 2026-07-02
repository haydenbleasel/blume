import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { resolveTsconfigAliases } from "../src/core/tsconfig-aliases.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-tsalias-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

const writeConfig = (content: string, name = "tsconfig.json"): Promise<void> =>
  writeFile(join(root, name), content, "utf-8");

describe("resolveTsconfigAliases", () => {
  it("maps @/* to an absolute src dir against baseUrl", async () => {
    await writeConfig(
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      })
    );

    expect(resolveTsconfigAliases(root)).toEqual({ "@": join(root, "src") });
  });

  it("handles the shadcn `@/*` -> `./*` default (alias to the root)", async () => {
    await writeConfig(
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } })
    );

    expect(resolveTsconfigAliases(root)).toEqual({ "@": root });
  });

  it("tolerates comments and trailing commas (JSONC)", async () => {
    await writeConfig(`{
      // the project's TypeScript config
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["./src/*"], }, /* shadcn style */
      },
    }`);

    expect(resolveTsconfigAliases(root)).toEqual({ "@": join(root, "src") });
  });

  it("maps multiple aliases and an exact (non-glob) key", async () => {
    await writeConfig(
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
            "@ui/*": ["./src/components/ui/*"],
            config: ["./app.config.ts"],
          },
        },
      })
    );

    expect(resolveTsconfigAliases(root)).toEqual({
      "@": join(root, "src"),
      "@ui": join(root, "src", "components", "ui"),
      config: join(root, "app.config.ts"),
    });
  });

  it("follows a relative `extends` to the file that declares paths", async () => {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      join(root, "config", "base.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      "utf-8"
    );
    await writeConfig(JSON.stringify({ extends: "./config/base.json" }));

    // baseUrl resolves against the base file's own directory.
    expect(resolveTsconfigAliases(root)).toEqual({
      "@": join(root, "config", "src"),
    });
  });

  it("handles escaped characters inside strings (JSONC scan)", async () => {
    await writeConfig(
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
        note: 'a \\ backslash and a " quote inside a string',
      })
    );

    expect(resolveTsconfigAliases(root)).toEqual({ "@": join(root, "src") });
  });

  it("follows a relative `extends` to a directory's tsconfig.json", async () => {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      join(root, "config", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "utf-8"
    );
    // `./config` probes `./config.json` (missing) then `./config/tsconfig.json`.
    await writeConfig(JSON.stringify({ extends: "./config" }));

    expect(resolveTsconfigAliases(root)).toEqual({
      "@": join(root, "config", "src"),
    });
  });

  it("returns {} when a relative `extends` resolves to nothing", async () => {
    await writeConfig(JSON.stringify({ extends: "./missing-base" }));
    expect(resolveTsconfigAliases(root)).toEqual({});
  });

  it("guards against a tsconfig that extends itself", async () => {
    await writeConfig(JSON.stringify({ extends: "./tsconfig.json" }));
    expect(resolveTsconfigAliases(root)).toEqual({});
  });

  it("iterates an `extends` array first-to-last to the one with paths", async () => {
    await writeFile(
      join(root, "a.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
      "utf-8"
    );
    await writeFile(
      join(root, "b.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "utf-8"
    );
    await writeConfig(JSON.stringify({ extends: ["./a.json", "./b.json"] }));

    expect(resolveTsconfigAliases(root)).toEqual({ "@": join(root, "src") });
  });

  it("follows a bare-specifier `extends` to a package's shared config", async () => {
    await mkdir(join(root, "node_modules", "@tsconfig", "base"), {
      recursive: true,
    });
    await writeFile(
      join(root, "node_modules", "@tsconfig", "base", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      "utf-8"
    );
    await writeConfig(JSON.stringify({ extends: "@tsconfig/base" }));

    // `createRequire.resolve` may return a realpath (macOS `/var` ->
    // `/private/var`), so assert the resolved suffix rather than the prefix.
    const aliases = resolveTsconfigAliases(root);
    expect(Object.keys(aliases)).toEqual(["@"]);
    expect(
      aliases["@"]?.endsWith(join("node_modules", "@tsconfig", "base", "src"))
    ).toBe(true);
  });

  it("resolves a bare `extends` via package main when tsconfig.json is absent", async () => {
    await mkdir(join(root, "node_modules", "tscfg"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "tscfg", "package.json"),
      JSON.stringify({ main: "./base.json", name: "tscfg" }),
      "utf-8"
    );
    await writeFile(
      join(root, "node_modules", "tscfg", "base.json"),
      JSON.stringify({ compilerOptions: { paths: { "~/*": ["./lib/*"] } } }),
      "utf-8"
    );
    // `tscfg/tsconfig.json` is absent, so resolution falls back to the bare
    // specifier, which resolves through the package `main`.
    await writeConfig(JSON.stringify({ extends: "tscfg" }));

    const aliases = resolveTsconfigAliases(root);
    expect(Object.keys(aliases)).toEqual(["~"]);
    expect(aliases["~"]?.endsWith(join("node_modules", "tscfg", "lib"))).toBe(
      true
    );
  });

  it("returns {} when a bare `extends` can't be resolved", async () => {
    await writeConfig(
      JSON.stringify({ extends: "@tsconfig/does-not-exist-xyz" })
    );
    expect(resolveTsconfigAliases(root)).toEqual({});
  });

  it("falls back to jsconfig.json", async () => {
    await writeConfig(
      JSON.stringify({ compilerOptions: { paths: { "~/*": ["./app/*"] } } }),
      "jsconfig.json"
    );

    expect(resolveTsconfigAliases(root)).toEqual({ "~": join(root, "app") });
  });

  it("skips a catch-all `*` mapping", async () => {
    await writeConfig(
      JSON.stringify({ compilerOptions: { paths: { "*": ["./types/*"] } } })
    );

    expect(resolveTsconfigAliases(root)).toEqual({});
  });

  it("returns {} when there's no config or it can't be parsed", async () => {
    expect(resolveTsconfigAliases(root)).toEqual({});

    await writeConfig("{ not valid json ");
    expect(resolveTsconfigAliases(root)).toEqual({});
  });
});
