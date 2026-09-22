import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  applyPlan,
  buildConfig,
  buildPlan,
  commandsFor,
  detectPackageManager,
  detectProjectPackageManager,
  nextSteps,
  titleize,
  validateContentDir,
} from "../src/cli/init/scaffold.ts";
import type { InitAnswers, ScaffoldLog } from "../src/cli/init/scaffold.ts";
import type { BlumeConfig } from "../src/core/config-input.ts";
import { blumePackageJson, toPackageName } from "../src/core/package-json.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { getBlumeVersion } from "../src/core/version.ts";
import { openapi } from "../src/reference/index.ts";
import {
  contentful,
  filesystem,
  githubReleases,
  mdxRemote,
  notion,
  obsidian,
  payload,
  sanity,
  strapi,
} from "../src/sources/index.ts";

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

/** The `blume/sources` factories a generated config may import, by name. */
const FACTORIES = {
  contentful,
  filesystem,
  githubReleases,
  mdxRemote,
  notion,
  obsidian,
  payload,
  sanity,
  strapi,
};

/**
 * Evaluate the generated `blume.config.ts` down to its config object. The
 * `blume/sources` and `blume/reference` factories a generated config imports
 * are passed in as arguments, since the evaluated body can't import.
 */
const evalConfig = (config: string): BlumeConfig => {
  const object = config
    .replace('import { defineConfig } from "blume";', "")
    .replaceAll(/import \{[^}]*\} from "blume\/(?:reference|sources)";/gu, "")
    .replace("export default defineConfig(", "return (")
    .replace(/\);\s*$/u, ");");
  // oxlint-disable-next-line no-new-func -- evaluating our own generated output
  return new Function(...Object.keys(FACTORIES), "openapi", object)(
    ...Object.values(FACTORIES),
    openapi
  );
};

const collectLog = () => {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (message) => lines.push(`info:${message}`),
      success: (message) => lines.push(`success:${message}`),
    } satisfies ScaffoldLog,
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

/**
 * Init a fixture repository with the repo-locating GIT_* variables a parent
 * git process exports to its hooks stripped out, so `-C` discovery is not
 * overridden by an absolute GIT_DIR under a pre-commit hook.
 */
const initRepo = (root: string): void => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") || key === "GIT_CONFIG_NOSYSTEM"
    )
  );
  // oxlint-disable-next-line sonarjs/no-os-command-from-path -- fixture drives a real git repo
  execFileSync("git", ["-C", root, "init", "-q"], { env, stdio: "ignore" });
};

const withUserAgent = async (
  userAgent: string,
  run: () => Promise<void>
): Promise<void> => {
  const previous = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = userAgent;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = previous;
    }
  }
};

describe("detectProjectPackageManager", () => {
  it("reads an existing project's manager from its lockfile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-pm-"));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      await writeFile(join(dir, "pnpm-lock.yaml"), "");
      // The lockfile wins even though this test process itself runs under a
      // different manager's user agent.
      expect(await detectProjectPackageManager(dir)).toBe("pnpm");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to the user agent when no lockfile is found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-pm-"));
    try {
      await withUserAgent("yarn/4.0.0 npm/? node/v20.0.0", async () => {
        expect(await detectProjectPackageManager(dir)).toBe("yarn");
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("climbs to the repository root for a workspace package", async () => {
    const repo = await mkdtemp(join(tmpdir(), "blume-pm-"));
    try {
      initRepo(repo);
      // A monorepo keeps one lockfile at its root; `apps/docs` has none.
      await writeFile(join(repo, "package.json"), "{}");
      await writeFile(join(repo, "pnpm-lock.yaml"), "");
      const dir = join(repo, "apps", "docs");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), "{}");
      await withUserAgent("npm/10.0.0 node/v22.0.0", async () => {
        expect(await detectProjectPackageManager(dir)).toBe("pnpm");
      });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  it("ignores a package.json above the project that is not its repository", async () => {
    const home = await mkdtemp(join(tmpdir(), "blume-pm-"));
    try {
      // A user's home directory with a stray `packageManager` field must not
      // decide the commands for a project it has nothing to do with.
      await writeFile(
        join(home, "package.json"),
        JSON.stringify({ packageManager: "pnpm@9.0.0" })
      );
      const dir = join(home, "project");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), "{}");
      await withUserAgent("yarn/4.0.0 npm/? node/v20.0.0", async () => {
        expect(await detectProjectPackageManager(dir)).toBe("yarn");
      });
      // Nor when the project is its own repository and the stray file sits
      // one level above the toplevel.
      initRepo(dir);
      await withUserAgent("yarn/4.0.0 npm/? node/v20.0.0", async () => {
        expect(await detectProjectPackageManager(dir)).toBe("yarn");
      });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
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
  it("uses `run` for npm, and for bun's shadowed `build` script", () => {
    expect(commandsFor("npm")).toEqual({
      build: "npm run build",
      dev: "npm run dev",
      exec: "npx",
      install: "npm install",
    });
    expect(commandsFor("pnpm")).toEqual({
      build: "pnpm build",
      dev: "pnpm dev",
      exec: "pnpm exec",
      install: "pnpm install",
    });
    // `bun build` is Bun's bundler ("Missing entrypoints"), not the script;
    // `bun dev` has no builtin and falls through to the script.
    expect(commandsFor("bun")).toEqual({
      build: "bun run build",
      dev: "bun dev",
      exec: "bunx",
      install: "bun install",
    });
  });

  it("maps each package manager to its local-bin exec prefix", () => {
    expect(commandsFor("npm").exec).toBe("npx");
    expect(commandsFor("pnpm").exec).toBe("pnpm exec");
    expect(commandsFor("yarn").exec).toBe("yarn");
    expect(commandsFor("bun").exec).toBe("bunx");
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
    const api = buildConfig(answersWith({ template: "api" }));
    expect(api).toContain("reference: [");
    expect(api).toContain("openapi({");
    expect(api).toContain('import { openapi } from "blume/reference";');
    expect(buildConfig(answersWith({ template: "changelog" }))).toContain(
      "navigation: {"
    );
    expect(buildConfig(answersWith({ template: "sdk" }))).not.toContain(
      "openapi({"
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
    expect(config).toContain(
      'import { filesystem, notion } from "blume/sources";'
    );
    expect(config).toContain('filesystem({ root: "content" }),');
    expect(config).toContain("notion({");
    expect(config).toContain("NOTION_TOKEN");
  });

  it("omits the filesystem source when only remote sources are picked", () => {
    const config = buildConfig(answersWith({ sources: ["github-releases"] }));
    expect(config).toContain('import { githubReleases } from "blume/sources";');
    expect(config).toContain("githubReleases({");
    expect(config).not.toContain("filesystem(");
  });

  it("imports nothing from blume/sources for the shorthand content block", () => {
    expect(buildConfig(answersWith({ contentDir: "content" }))).not.toContain(
      "blume/sources"
    );
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
          "contentful",
          "payload",
          "strapi",
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
    // SAFETY: blumePackageJson emits a manifest whose dependencies block is
    // asserted on right below.
    const json = JSON.parse(
      blumePackageJson("docs", { "@notionhq/client": "^5.26.0" })
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

  it("seeds a vault note when the obsidian source is selected", () => {
    const paths = buildPlan(
      "/proj",
      answersWith({ sources: ["obsidian"] })
    ).map((file) => file.path);
    // The scaffolded config points at `vault/`; without the directory the
    // fresh project fails the source's `validate()` on first `blume dev`.
    expect(paths).toContain("/proj/vault/Welcome.md");
    // No filesystem source selected, so no starter pages under the content dir.
    expect(paths).not.toContain("/proj/docs/index.mdx");
  });

  it("adds source SDK deps to the planned package.json", () => {
    const [pkg] = buildPlan(
      "/proj",
      answersWith({ sources: ["filesystem", "notion", "sanity"] })
    );
    expect(pkg?.content).toContain('"@notionhq/client": "^5.26.0"');
    expect(pkg?.content).toContain('"@sanity/client": "^7.25.0"');
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

  it("adds a cd hint for non-cwd targets and honors the package manager", () => {
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
