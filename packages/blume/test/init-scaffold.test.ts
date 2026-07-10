import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  applyPlan,
  buildConfig,
  buildPlan,
  commandsFor,
  detectPackageManager,
  nextSteps,
  titleize,
  validateContentDir,
} from "../src/cli/init/scaffold.ts";
import type { InitAnswers, ScaffoldLog } from "../src/cli/init/scaffold.ts";
import { blumePackageJson, toPackageName } from "../src/core/package-json.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { getBlumeVersion } from "../src/core/version.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-init-"));
  tempDirs.push(dir);
  return dir;
};

const answersWith = (overrides: Partial<InitAnswers> = {}): InitAnswers => ({
  contentDir: "docs",
  directory: ".",
  packageManager: "npm",
  sources: ["filesystem"],
  template: "docs",
  title: "My Docs",
  ...overrides,
});

/** Evaluate the generated `blume.config.ts` down to its config object. */
const evalConfig = (config: string): unknown => {
  const object = config
    .replace('import { defineConfig } from "blume";', "")
    .replace("export default defineConfig(", "return (")
    .replace(/\);\s*$/u, ");");
  // oxlint-disable-next-line no-new-func -- evaluating our own generated output
  return new Function(object)();
};

const collectLog = (): { lines: string[]; log: ScaffoldLog } => {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (message) => lines.push(`info:${message}`),
      success: (message) => lines.push(`success:${message}`),
    },
  };
};

describe("detectPackageManager", () => {
  it("reads the package manager from the npm user agent", () => {
    expect(detectPackageManager("pnpm/9.1.0 npm/? node/v20.0.0")).toBe("pnpm");
    expect(detectPackageManager("yarn/4.0.0 npm/? node/v20.0.0")).toBe("yarn");
    expect(detectPackageManager("bun/1.2.0 npm/? node/v22.0.0")).toBe("bun");
    expect(detectPackageManager("npm/10.5.0 node/v20.0.0")).toBe("npm");
  });

  it("falls back to npm for missing or unknown agents", () => {
    expect(detectPackageManager()).toBe("npm");
    expect(detectPackageManager("deno/2.0.0")).toBe("npm");
    expect(detectPackageManager("")).toBe("npm");
  });
});

describe("validateContentDir", () => {
  it("accepts relative paths inside the project", () => {
    expect(validateContentDir("/proj", "docs")).toBeUndefined();
    expect(validateContentDir("/proj", "content/docs")).toBeUndefined();
  });

  it("rejects absolute and escaping paths", () => {
    expect(validateContentDir("/proj", "/etc")).toBeDefined();
    expect(validateContentDir("/proj", "../outside")).toBeDefined();
    expect(validateContentDir("/proj", "docs/../../outside")).toBeDefined();
  });
});

describe("titleize", () => {
  it("turns directory names into display titles", () => {
    expect(titleize("my-docs")).toBe("My Docs");
    expect(titleize("acme_api.reference")).toBe("Acme Api Reference");
    expect(titleize("docs")).toBe("Docs");
  });

  it("falls back when nothing usable remains", () => {
    expect(titleize("")).toBe("My Docs");
    expect(titleize("---")).toBe("My Docs");
  });
});

describe("commandsFor", () => {
  it("uses `run` only for npm", () => {
    expect(commandsFor("npm")).toEqual({
      dev: "npm run dev",
      install: "npm install",
    });
    expect(commandsFor("pnpm")).toEqual({
      dev: "pnpm dev",
      install: "pnpm install",
    });
  });
});

describe("buildConfig", () => {
  it("produces the legacy default config byte-for-byte", () => {
    expect(buildConfig(answersWith()))
      .toBe(`import { defineConfig } from "blume";

export default defineConfig({
  title: "My Docs",
  description: "Documentation powered by Blume.",
});
`);
  });

  it("injects the chosen title", () => {
    const config = buildConfig(answersWith({ title: 'Acme "Docs"' }));
    expect(config).toContain('title: "Acme \\"Docs\\""');
  });

  it("keeps each template's config fragment", () => {
    expect(buildConfig(answersWith({ template: "api" }))).toContain(
      "openapi: {"
    );
    expect(buildConfig(answersWith({ template: "changelog" }))).toContain(
      "navigation: {"
    );
    expect(buildConfig(answersWith({ template: "sdk" }))).not.toContain(
      "openapi: {"
    );
  });

  it("emits content.root for a non-default content dir", () => {
    const config = buildConfig(answersWith({ contentDir: "content" }));
    expect(config).toContain('root: "content"');
    expect(config).not.toContain("sources: [");
  });

  it("omits the content block for default filesystem answers", () => {
    expect(buildConfig(answersWith({ sources: [] }))).not.toContain(
      "content: {"
    );
  });

  it("lists an explicit filesystem source beside remote sources", () => {
    const config = buildConfig(
      answersWith({ contentDir: "content", sources: ["filesystem", "notion"] })
    );
    expect(config).toContain('{ type: "filesystem", root: "content" },');
    expect(config).toContain('type: "notion"');
    expect(config).toContain("NOTION_TOKEN");
  });

  it("omits the filesystem source when only remote sources are picked", () => {
    const config = buildConfig(answersWith({ sources: ["github-releases"] }));
    expect(config).toContain('type: "github-releases"');
    expect(config).not.toContain('type: "filesystem"');
  });

  it("generates schema-valid configs for every source combination", () => {
    for (const answers of [
      answersWith(),
      answersWith({ contentDir: "content" }),
      answersWith({ template: "api" }),
      answersWith({ sources: ["github-releases"], template: "changelog" }),
      answersWith({
        sources: [
          "filesystem",
          "github-releases",
          "notion",
          "sanity",
          "mdx-remote",
        ],
      }),
    ]) {
      const parsed = blumeConfigSchema.safeParse(
        evalConfig(buildConfig(answers))
      );
      expect(parsed.success).toBe(true);
    }
  });
});

describe("blumePackageJson", () => {
  it("matches the legacy shape without extra deps", () => {
    expect(blumePackageJson("docs")).toBe(`{
  "name": "docs",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "blume dev",
    "build": "blume build",
    "doctor": "blume doctor"
  },
  "dependencies": {
    "blume": "^${getBlumeVersion()}"
  }
}
`);
  });

  it("merges and sorts extra dependencies", () => {
    const json = JSON.parse(
      blumePackageJson("docs", { "@notionhq/client": "^2.2.15" })
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(json.dependencies)).toEqual([
      "@notionhq/client",
      "blume",
    ]);
  });

  it("derives package names from directory names", () => {
    expect(toPackageName("My Docs!")).toBe("my-docs");
    expect(toPackageName("---")).toBe("docs");
  });
});

describe("buildPlan", () => {
  it("plans package.json, config, and seed pages", () => {
    const paths = buildPlan("/proj", answersWith()).map((file) => file.path);
    expect(paths).toEqual([
      "/proj/package.json",
      "/proj/blume.config.ts",
      "/proj/docs/index.mdx",
    ]);
  });

  it("seeds template-specific pages under the content dir", () => {
    const api = buildPlan("/proj", answersWith({ template: "api" })).map(
      (file) => file.path
    );
    expect(api).toContain("/proj/docs/index.mdx");
    const changelog = buildPlan(
      "/proj",
      answersWith({ contentDir: "content", template: "changelog" })
    ).map((file) => file.path);
    expect(changelog).toContain("/proj/content/changelog/v1-0-0.mdx");
    const sdk = buildPlan("/proj", answersWith({ template: "sdk" })).map(
      (file) => file.path
    );
    expect(sdk).toContain("/proj/docs/installation.mdx");
  });

  it("adds source SDK deps to the planned package.json", () => {
    const [pkg] = buildPlan(
      "/proj",
      answersWith({ sources: ["filesystem", "notion", "sanity"] })
    );
    expect(pkg?.content).toContain('"@notionhq/client": "^2.2.15"');
    expect(pkg?.content).toContain('"@sanity/client": "^6.21.0"');
  });

  it("skips seed pages when no filesystem source is selected", () => {
    const paths = buildPlan("/proj", answersWith({ sources: ["notion"] })).map(
      (file) => file.path
    );
    expect(paths).toEqual(["/proj/package.json", "/proj/blume.config.ts"]);
  });

  it("treats an empty source list as the implicit filesystem source", () => {
    const paths = buildPlan("/proj", answersWith({ sources: [] })).map(
      (file) => file.path
    );
    expect(paths).toContain("/proj/docs/index.mdx");
  });
});

describe("applyPlan", () => {
  it("writes planned files and reports the created package.json", async () => {
    const root = await makeTempDir();
    const { lines, log } = collectLog();
    const plan = buildPlan(root, answersWith());
    const { createdPackage } = await applyPlan(plan, log);
    expect(createdPackage).toBe(true);
    expect(readFileSync(join(root, "blume.config.ts"), "utf-8")).toContain(
      "defineConfig"
    );
    expect(readFileSync(join(root, "docs", "index.mdx"), "utf-8")).toContain(
      "# Introduction"
    );
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith("success:Created "))).toBe(
      true
    );
  });

  it("skips existing files on re-run", async () => {
    const root = await makeTempDir();
    const plan = buildPlan(root, answersWith());
    await applyPlan(plan, collectLog().log);
    const { lines, log } = collectLog();
    const { createdPackage } = await applyPlan(plan, log);
    expect(createdPackage).toBe(false);
    expect(
      lines.every((line) => line.startsWith("info:Skipped existing "))
    ).toBe(true);
  });
});

describe("nextSteps", () => {
  it("matches the legacy default message", () => {
    expect(nextSteps(answersWith(), true)).toBe(
      "Next steps:\n\n  npm install\n  npm run dev\n"
    );
  });

  it("drops the install line when package.json already existed", () => {
    expect(nextSteps(answersWith(), false)).toBe(
      "Next steps:\n\n  npm run dev\n"
    );
  });

  it("adds a cd hint for non-cwd targets and honours the package manager", () => {
    const steps = nextSteps(
      answersWith({ directory: "my-docs", packageManager: "pnpm" }),
      true
    );
    expect(steps).toContain("  cd my-docs\n  pnpm install\n  pnpm dev");
  });

  it("names the env vars the selected sources authenticate with", () => {
    const steps = nextSteps(
      answersWith({ sources: ["filesystem", "github-releases", "sanity"] }),
      true
    );
    expect(steps).toContain(
      "Set GITHUB_TOKEN and SANITY_TOKEN in .env.local so your sources can authenticate."
    );
    expect(nextSteps(answersWith(), true)).not.toContain(".env.local");
  });
});
