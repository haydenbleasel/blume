import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  UPGRADE_GUIDE_URL,
  bumpBlumeDependency,
  collectUpgradeFindings,
  flagList,
  isOutsideBlumeProject,
  rangeMajor,
  removedBuildFlags,
  removedBuildFlagsAdvice,
  upgradePrompt,
} from "../src/upgrade/upgrade.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-upgrade-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const packageJson = (deps: Record<string, Record<string, string>>): string =>
  `${JSON.stringify({ name: "docs", private: true, ...deps }, null, 2)}\n`;

describe("rangeMajor", () => {
  it("reads the major a range pins", () => {
    expect(rangeMajor("^1.7.3")).toBe(1);
    expect(rangeMajor("~1.2.0")).toBe(1);
    expect(rangeMajor(">=1 <2")).toBe(1);
    expect(rangeMajor("v2.0.0")).toBe(2);
    expect(rangeMajor("2")).toBe(2);
  });

  it("returns null for a range that names no version", () => {
    expect(rangeMajor("workspace:*")).toBeNull();
    expect(rangeMajor("workspace:^1.0.0")).toBeNull();
    expect(rangeMajor("latest")).toBeNull();
    expect(rangeMajor("*")).toBeNull();
  });
});

describe("bumpBlumeDependency", () => {
  it("reports a project with no package.json as missing", async () => {
    const root = await project({});
    expect(await bumpBlumeDependency(root, "2.0.0")).toEqual({
      status: "missing",
    });
  });

  it("reports a package.json that doesn't list blume as missing", async () => {
    const root = await project({
      "package.json": packageJson({ dependencies: { astro: "^7.0.0" } }),
    });
    expect(await bumpBlumeDependency(root, "2.0.0")).toEqual({
      status: "missing",
    });
  });

  it("bumps an older major in dependencies and keeps the rest", async () => {
    const root = await project({
      "package.json": packageJson({
        dependencies: { blume: "^1.7.3", react: "^19.2.0" },
      }),
    });
    expect(await bumpBlumeDependency(root, "2.0.0")).toEqual({
      field: "dependencies",
      from: "^1.7.3",
      status: "bumped",
      to: "^2.0.0",
    });
    const written = JSON.parse(
      await readFile(join(root, "package.json"), "utf-8")
    );
    expect(written.dependencies).toEqual({ blume: "^2.0.0", react: "^19.2.0" });
    expect(written.name).toBe("docs");
  });

  it("bumps a devDependency and keeps the file's indentation", async () => {
    const root = await project({
      "package.json": `${JSON.stringify({ devDependencies: { blume: "~1.2.0" } }, null, 4)}\n`,
    });
    const bump = await bumpBlumeDependency(root, "2.1.0");
    expect(bump).toMatchObject({ field: "devDependencies", status: "bumped" });
    const text = await readFile(join(root, "package.json"), "utf-8");
    expect(text).toBe(
      `${JSON.stringify({ devDependencies: { blume: "^2.1.0" } }, null, 4)}\n`
    );
  });

  it("changes only the range, keeping inline objects and key order", async () => {
    const text =
      '{"name":"docs","dependencies":{"react":"^19.2.0","blume":"^1.7.3"},\n  "peerDependencies": { "blume": "^1.7.3" }}\n';
    const root = await project({ "package.json": text });
    expect(await bumpBlumeDependency(root, "2.0.0")).toMatchObject({
      field: "dependencies",
      status: "bumped",
    });
    expect(await readFile(join(root, "package.json"), "utf-8")).toBe(
      text.replace('"blume":"^1.7.3"', '"blume":"^2.0.0"')
    );
  });

  it("rewrites the file when the entry is escaped past an in-place edit", async () => {
    const root = await project({
      "package.json":
        '{\n  "devDependencies": { "blume": "\\u005e1.0.0" }\n}\n',
    });
    expect(await bumpBlumeDependency(root, "2.0.0")).toMatchObject({
      from: "^1.0.0",
      status: "bumped",
    });
    expect(
      JSON.parse(await readFile(join(root, "package.json"), "utf-8"))
    ).toEqual({ devDependencies: { blume: "^2.0.0" } });
  });

  it("leaves a range already on the major alone", async () => {
    const root = await project({
      "package.json": packageJson({ dependencies: { blume: "^2.1.0" } }),
    });
    expect(await bumpBlumeDependency(root, "2.0.0")).toEqual({
      range: "^2.1.0",
      status: "current",
    });
  });

  it("leaves a workspace or tag range to the user", async () => {
    const root = await project({
      "package.json": packageJson({ dependencies: { blume: "workspace:*" } }),
    });
    expect(await bumpBlumeDependency(root, "2.0.0")).toEqual({
      range: "workspace:*",
      status: "current",
    });
  });
});

describe("collectUpgradeFindings", () => {
  it("returns nothing for a project that already fits", async () => {
    const root = await project({
      "blume.config.ts": 'export default { title: "Docs" };\n',
      "docs/index.md": "# Home\n",
    });
    expect(await collectUpgradeFindings(root)).toEqual([]);
  });

  it("reports each Blume 1 field on its own, at its own line", async () => {
    const root = await project({
      "blume.config.ts": `export default {
  search: { provider: "pagefind" },
  lastModified: true,
};
`,
    });
    const findings = await collectUpgradeFindings(root);
    expect(
      findings.map((finding) => [finding.code, finding.line])
    ).toStrictEqual([
      ["BLUME_CONFIG_INVALID", 2],
      ["BLUME_CONFIG_INVALID", 3],
    ]);
    expect(findings[0]?.message).toContain('adapter from "blume/search"');
    expect(findings[1]?.message).toContain('`true` became "git"');
  });

  it("reports ai.ask, renamed to ai.assistant, at its line", async () => {
    const root = await project({
      "blume.config.ts": `export default {
  ai: {
    ask: { enabled: true },
  },
};
`,
    });
    const findings = await collectUpgradeFindings(root);
    expect(
      findings.map((finding) => [finding.code, finding.line])
    ).toStrictEqual([["BLUME_CONFIG_INVALID", 3]]);
    expect(findings[0]?.message).toContain(
      "ai.ask was renamed to ai.assistant."
    );
  });

  it("reports a package.json script that passes a removed build flag", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "package.json": `${JSON.stringify(
        {
          dependencies: { blume: "^2.0.0" },
          scripts: {
            build: "blume build --adapter vercel --output=server",
            "build:docs": "cd docs && npx blume@2 build --base /docs --strict",
            dev: "blume dev --port 3000",
            lint: "eslint . --output report.json",
          },
        },
        null,
        2
      )}\n`,
    });
    const findings = await collectUpgradeFindings(root);
    expect(
      findings.map((finding) => [finding.code, finding.line, finding.message])
    ).toStrictEqual([
      [
        "BLUME_BUILD_FLAG_REMOVED",
        6,
        'The "build" script passes --adapter, --output to `blume build`, which Blume 2 removed.',
      ],
      [
        "BLUME_BUILD_FLAG_REMOVED",
        7,
        'The "build:docs" script passes --base to `blume build`, which Blume 2 removed.',
      ],
    ]);
    expect(findings[1]?.suggestion).toBe(removedBuildFlagsAdvice(["base"]));
  });

  it("ignores scripts that aren't all strings", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "package.json": JSON.stringify({ scripts: { build: ["blume build"] } }),
    });
    expect(await collectUpgradeFindings(root)).toEqual([]);
  });

  it("reports each components.ts entry Blume can't plan at its line", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "components.ts":
        'import Counter from "./islands/Counter.tsx";\nexport default {\n  islands: { Counter },\n  mdx: { Callout: "./Callout.astro" },\n};\n',
    });
    const findings = await collectUpgradeFindings(root);
    expect(
      findings.map((finding) => [finding.code, finding.line])
    ).toStrictEqual([
      ["BLUME_COMPONENTS_INVALID", 3],
      ["BLUME_COMPONENTS_INVALID", 4],
    ]);
    expect(findings[0]?.message).toContain("The `islands` group was folded");
    expect(findings[1]?.message).toContain(
      'mdx.Callout points at "./Callout.astro", but no file exists there'
    );
  });

  it("reports a config that won't load", async () => {
    const root = await project({ "blume.config.ts": "export default {\n" });
    const findings = await collectUpgradeFindings(root);
    expect(findings.map((finding) => finding.code)).toEqual([
      "BLUME_CONFIG_LOAD_FAILED",
    ]);
  });

  it("rethrows a failure that isn't a Blume diagnostic", async () => {
    // A directory named like the components file passes the lookup but can't
    // be read — an I/O error, not something the upgrade should report.
    const root = await project({ "blume.config.ts": "export default {};\n" });
    await mkdir(join(root, "components.ts"));
    await expect(collectUpgradeFindings(root)).rejects.toThrow();
  });
});

describe("isOutsideBlumeProject", () => {
  it("is true with neither a config nor a blume dependency", async () => {
    const root = await project({});
    expect(isOutsideBlumeProject(root, { status: "missing" })).toBeTrue();
  });

  it("is false for a zero-config project that lists blume", async () => {
    const root = await project({});
    expect(
      isOutsideBlumeProject(root, { range: "^2.0.0", status: "current" })
    ).toBeFalse();
  });

  it("is false for a config without a blume dependency", async () => {
    const root = await project({ "blume.config.ts": "export default {};\n" });
    expect(isOutsideBlumeProject(root, { status: "missing" })).toBeFalse();
  });
});

describe("removed build flags", () => {
  it("finds each removed flag once, bare or with a value", () => {
    expect(
      removedBuildFlags([
        "--output=server",
        "--adapter",
        "vercel",
        "--output",
        "--strict",
        "--base-url",
        "--base",
      ])
    ).toEqual(["output", "adapter", "base"]);
    expect(removedBuildFlags(["--isolated", "--no-strict"])).toEqual([]);
  });

  it("lists the flags as typed", () => {
    expect(flagList(["adapter", "base"])).toBe("--adapter, --base");
  });

  it("points each flag at the deployment config that replaced it", () => {
    expect(removedBuildFlagsAdvice(["output"])).toBe(
      'Drop --output and name the host in blume.config.ts with `deployment: vercel()` (or `netlify()`, `cloudflare()`, `node()`) from "blume/deploy" — a host adapter builds for the server, and `output: "static"` keeps it static.'
    );
    expect(removedBuildFlagsAdvice(["base"])).toBe(
      'Drop --base and set the subpath with `deployment: { base: "/docs" }`, or the host adapter\'s `base` option.'
    );
    expect(removedBuildFlagsAdvice(["adapter", "base"])).toContain(
      "keeps it static; set the subpath"
    );
  });
});

describe("upgradePrompt", () => {
  it("lists each finding with its location and fix beside the guide", () => {
    const root = "/project";
    const prompt = upgradePrompt({
      findings: [
        {
          code: "BLUME_CONFIG_INVALID",
          file: "/project/blume.config.ts",
          line: 3,
          message: "ai.mcp moved to agents.mcp.\n1 more config issue(s):",
          severity: "error",
        },
        {
          code: "BLUME_COMPONENTS_INVALID",
          file: "/project/components.ts",
          message: "components.ts has 1 override(s) Blume can't plan.",
          severity: "error",
          suggestion: "Import each component.",
        },
        {
          code: "BLUME_CONFIG_LOAD_FAILED",
          message: "Failed to load config.",
          severity: "error",
        },
      ],
      guidePath: "/pkg/docs/03-upgrading.mdx",
      root,
      runner: "pnpm exec",
      version: "2.0.0",
    });
    expect(prompt).toContain("Blume 2.0.0");
    expect(prompt).toContain("/pkg/docs/03-upgrading.mdx");
    expect(prompt).toContain(UPGRADE_GUIDE_URL);
    // Location, code, and the message's continuation lines indented under it.
    expect(prompt).toContain(
      "- blume.config.ts:3 (BLUME_CONFIG_INVALID)\n  ai.mcp moved to agents.mcp.\n  1 more config issue(s):"
    );
    expect(prompt).toContain(
      "- components.ts (BLUME_COMPONENTS_INVALID)\n  components.ts has 1 override(s) Blume can't plan.\n  Fix: Import each component."
    );
    // A finding with no file names the config, where every load error lives.
    expect(prompt).toContain("- blume.config.ts (BLUME_CONFIG_LOAD_FAILED)");
    expect(prompt).toContain("`pnpm exec blume doctor`");
    expect(prompt).toContain("`pnpm exec blume build`");
  });
});
