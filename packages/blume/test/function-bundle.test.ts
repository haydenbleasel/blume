import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  auditFunctionBundle,
  auditVercelFunctions,
  blumeDependencyNames,
  functionBundleVerdict,
  importedPackages,
  packageName,
} from "../src/deploy/function-bundle.ts";

describe("packageName", () => {
  it("reduces a specifier to its package", () => {
    expect(packageName("zod")).toBe("zod");
    expect(packageName("zod/v4")).toBe("zod");
    expect(packageName("@modelcontextprotocol/sdk/server/index.js")).toBe(
      "@modelcontextprotocol/sdk"
    );
  });

  it("ignores relative, absolute, builtin, and virtual ids", () => {
    expect(packageName("./chunk.mjs")).toBeNull();
    expect(packageName("../chunk.mjs")).toBeNull();
    expect(packageName("/abs/chunk.mjs")).toBeNull();
    expect(packageName("node:path")).toBeNull();
    expect(packageName("fs")).toBeNull();
    expect(packageName("astro:content")).toBeNull();
    expect(packageName("virtual:blume")).toBeNull();
    expect(packageName("data:text/javascript,1")).toBeNull();
    expect(packageName("\0rolldown")).toBeNull();
  });

  it("rejects a bare scope or an empty specifier", () => {
    expect(packageName("@scope")).toBeNull();
    expect(packageName("")).toBeNull();
  });
});

describe("importedPackages", () => {
  it("reads static, side-effect, re-export, and dynamic imports", async () => {
    const source = [
      'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
      "import * as orama from '@orama/orama';",
      'import "katex";',
      'export { x } from "ufo";',
      'export * from "zod/v4";',
      'const lazy = () => import("sharp");',
      'import { r as runtime } from "./rolldown-runtime.mjs";',
      'import { readFile } from "node:fs/promises";',
    ].join("\n");
    expect(await importedPackages(source)).toStrictEqual([
      "@modelcontextprotocol/sdk",
      "@orama/orama",
      "katex",
      "ufo",
      "zod",
      "sharp",
    ]);
  });

  it("handles minified statements with no whitespace", async () => {
    expect(
      await importedPackages(
        ';import{z}from"zod";export*from"ufo";import"katex"'
      )
    ).toStrictEqual(["zod", "ufo", "katex"]);
  });

  it("dedupes a package imported through several subpaths", async () => {
    expect(
      await importedPackages('import "zod";\nimport { z } from "zod/v4";')
    ).toStrictEqual(["zod"]);
  });

  it("ignores code samples inside a serialized data module", async () => {
    // The MCP snapshot chunk is `JSON.parse("…")` over every page's Markdown
    // and plain text. A docs page quoting `import { config } from 'dotenv'`
    // (single quotes survive JSON unescaped) or `await import('bcryptjs')`
    // is prose there, not a module the function needs.
    const page = [
      "Load env vars with import { config } from 'dotenv' first.",
      "```ts",
      "import { config } from 'dotenv'",
      'import { hydrateRoot } from "react-dom/client";',
      "const bcrypt = await import('bcryptjs');",
      "export { PrismaClient } from 'prisma';",
      "```",
    ].join("\n");
    const chunk = `var data = JSON.parse(${JSON.stringify(JSON.stringify({ documents: [{ content: page }] }))});\nexport { data as t };\n`;
    expect(await importedPackages(chunk)).toStrictEqual([]);
  });

  it("ignores a runtime message that quotes an export name", async () => {
    // Astro's handler-name hint (`did you mean to export 'ALL'?`) lives in a
    // template literal, not an export statement.
    const source =
      "throw new Error(`One of the exported handlers is \"all\", did you mean to export 'ALL'?`);";
    expect(await importedPackages(source)).toStrictEqual([]);
  });

  it("ignores import.meta and template-literal dynamic imports", async () => {
    // `import.meta` names nothing, and a glob like `import(\`@scope/${x}\`)`
    // was already resolved by the bundler into concrete chunks.
    const source = `console.log(import.meta.url);\nconst a = import(\`@scope/\${x}\`);\nconst b = import(name);\nimport "katex";`;
    expect(await importedPackages(source)).toStrictEqual(["katex"]);
  });

  it("falls back to a textual scan when the lexer rejects the module", async () => {
    // An unterminated string is a parse error to es-module-lexer; the module
    // is still audited by the regex scan rather than skipped.
    const source =
      'import { z } from "zod";\nexport * from "ufo";\nconst lazy = () => import("sharp");\nconst broken = "oops\n';
    expect(await importedPackages(source)).toStrictEqual([
      "zod",
      "ufo",
      "sharp",
    ]);
  });
});

const writeModule = async (path: string, source: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf-8");
};

const installPackage = async (dir: string, name: string) => {
  await mkdir(join(dir, "node_modules", name), { recursive: true });
  await writeFile(
    join(dir, "node_modules", name, "package.json"),
    JSON.stringify({ name }),
    "utf-8"
  );
};

describe("auditFunctionBundle", () => {
  let root: string;
  let funcDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "blume-function-bundle-"));
    funcDir = join(root, ".vercel", "output", "functions", "_render.func");
    await mkdir(funcDir, { recursive: true });
    await writeFile(
      join(funcDir, ".vc-config.json"),
      JSON.stringify({
        handler: "apps/docs/dist/server/entry.mjs",
        runtime: "nodejs22.x",
      }),
      "utf-8"
    );
    const serverDir = join(funcDir, "apps", "docs", "dist", "server");
    await writeModule(
      join(serverDir, "entry.mjs"),
      'import { escape } from "html-escaper";\nimport "./chunks/mcp.mjs";\nimport { create } from "@orama/orama";\n'
    );
    await writeModule(
      join(serverDir, "chunks", "mcp.mjs"),
      'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { z } from "zod";\nimport { joinURL } from "ufo";\nimport { nested } from "nested-dep";\n'
    );
    // Something that isn't a module must be skipped, as must a nested
    // node_modules tree (its own imports resolve from its real location).
    await writeModule(join(serverDir, "manifest.json"), '{"x":1}');
    await writeModule(
      join(serverDir, "node_modules", "ignored", "index.mjs"),
      'import "never-checked";'
    );
    // Traced at the function root (resolvable from any chunk)…
    await installPackage(funcDir, "@orama/orama");
    // …traced beside the chunk (resolvable from that chunk only)…
    await installPackage(join(serverDir, "chunks"), "nested-dep");
    // …and a store-style symlink, which a real trace preserves.
    const store = join(funcDir, "node_modules", ".store", "ufo@1.0.0", "ufo");
    await mkdir(store, { recursive: true });
    await writeFile(
      join(store, "package.json"),
      JSON.stringify({ name: "ufo" }),
      "utf-8"
    );
    await symlink(
      process.platform === "win32" ? store : join(".store", "ufo@1.0.0", "ufo"),
      join(funcDir, "node_modules", "ufo"),
      process.platform === "win32" ? "junction" : "file"
    );
    // A package installed *above* the function root is not part of the
    // bundle and must not count.
    await installPackage(root, "html-escaper");
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("reports the packages no node_modules in the bundle provides", async () => {
    const missing = await auditFunctionBundle(funcDir);
    expect(missing).toStrictEqual([
      {
        importers: ["apps/docs/dist/server/chunks/mcp.mjs"],
        name: "@modelcontextprotocol/sdk",
      },
      {
        importers: ["apps/docs/dist/server/entry.mjs"],
        name: "html-escaper",
      },
      {
        importers: ["apps/docs/dist/server/chunks/mcp.mjs"],
        name: "zod",
      },
    ]);
  });

  it("returns nothing for a function without a config or handler", async () => {
    const bare = join(root, "bare.func");
    await mkdir(bare, { recursive: true });
    expect(await auditFunctionBundle(bare)).toStrictEqual([]);
    await writeFile(
      join(bare, ".vc-config.json"),
      JSON.stringify({ runtime: "nodejs22.x" }),
      "utf-8"
    );
    expect(await auditFunctionBundle(bare)).toStrictEqual([]);
  });

  it("returns nothing when the handler directory is absent", async () => {
    const stub = join(root, "stub.func");
    await mkdir(stub, { recursive: true });
    await writeFile(
      join(stub, ".vc-config.json"),
      JSON.stringify({ handler: "dist/server/entry.mjs" }),
      "utf-8"
    );
    expect(await auditFunctionBundle(stub)).toStrictEqual([]);
  });

  it("stops at the filesystem root when the handler lives outside the function", async () => {
    // A handler path that escapes the function directory walks up past it;
    // the search ends at the filesystem root rather than looping.
    const escaped = join(root, "escaped.func");
    await mkdir(escaped, { recursive: true });
    await writeFile(
      join(escaped, ".vc-config.json"),
      JSON.stringify({ handler: "../outside/entry.mjs" }),
      "utf-8"
    );
    await writeModule(
      join(root, "outside", "entry.mjs"),
      'import "definitely-not-installed-anywhere";'
    );
    expect(await auditFunctionBundle(escaped)).toStrictEqual([
      {
        importers: ["../outside/entry.mjs"],
        name: "definitely-not-installed-anywhere",
      },
    ]);
  });

  it("audits every .func directory in a Build Output tree", async () => {
    const outputDir = join(root, ".vercel", "output");
    // A complete function and a stray file must both be skipped.
    const complete = join(outputDir, "functions", "ok.func");
    await mkdir(complete, { recursive: true });
    await writeFile(
      join(complete, ".vc-config.json"),
      JSON.stringify({ handler: "index.mjs" }),
      "utf-8"
    );
    await writeModule(join(complete, "index.mjs"), 'import "node:fs";');
    await writeFile(join(outputDir, "functions", "notes.txt"), "", "utf-8");

    const audits = await auditVercelFunctions(outputDir);
    expect(audits.map((audit) => audit.dir)).toStrictEqual([funcDir]);
    expect(audits[0]?.missing.map((entry) => entry.name)).toStrictEqual([
      "@modelcontextprotocol/sdk",
      "html-escaper",
      "zod",
    ]);
  });

  it("yields nothing for a static output tree", async () => {
    const staticDir = join(root, "static-output");
    await mkdir(join(staticDir, "static"), { recursive: true });
    expect(await auditVercelFunctions(staticDir)).toStrictEqual([]);
  });
});

describe("functionBundleVerdict", () => {
  const audit = {
    dir: "/site/.vercel/output/functions/_render.func",
    missing: [
      {
        importers: ["dist/server/chunks/mcp.mjs"],
        name: "@modelcontextprotocol/sdk",
      },
      { importers: ["dist/server/entry.mjs"], name: "left-pad" },
    ],
  };

  it("is fatal when a missing package is one of Blume's own dependencies", () => {
    const verdict = functionBundleVerdict(
      audit,
      "/site",
      new Set(["@modelcontextprotocol/sdk"])
    );
    expect(verdict.fatal).toBe(true);
    expect(verdict.message).toContain(
      ".vercel/output/functions/_render.func is missing packages"
    );
    expect(verdict.message).toContain(
      "  - @modelcontextprotocol/sdk (imported by dist/server/chunks/mcp.mjs)"
    );
    expect(verdict.message).toContain(
      "  npm install -D @modelcontextprotocol/sdk left-pad"
    );
  });

  it("only warns when every missing package is the project's own", () => {
    const verdict = functionBundleVerdict(audit, "/site", new Set(["zod"]));
    expect(verdict.fatal).toBe(false);
  });

  it("names the function directory verbatim when it isn't under the root", () => {
    const verdict = functionBundleVerdict(
      { ...audit, dir: "/elsewhere/_render.func" },
      "/elsewhere/_render.func",
      new Set()
    );
    expect(verdict.message).toContain(
      "bundle at /elsewhere/_render.func is missing"
    );
  });
});

describe("blumeDependencyNames", () => {
  it("reads the runtime dependencies from Blume's own manifest", () => {
    const names = blumeDependencyNames();
    expect(names.has("astro")).toBe(true);
    expect(names.has("@modelcontextprotocol/sdk")).toBe(true);
    expect(names.has("typescript")).toBe(true);
  });
});
