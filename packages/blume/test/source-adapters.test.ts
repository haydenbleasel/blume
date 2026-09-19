import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { sourceAdapterWarnings } from "../src/astro/generate.ts";
import { runtimeDependencies } from "../src/astro/templates.ts";
import { checkRequiredSecrets } from "../src/cli/required-secrets.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { resolveProjectContext } from "../src/core/project.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  resolveDocsCollection,
  resolveSources,
  sourcesOfKind,
} from "../src/core/sources/resolve.ts";
import type { ContentSource } from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";
import {
  custom,
  filesystem,
  githubReleases,
  mdxRemote,
  notion,
  obsidian,
  sanity,
} from "../src/sources/index.ts";
import type { AnySourceAdapter } from "../src/sources/index.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const memory: ContentSource = {
  load: () => Promise.resolve({ diagnostics: [], entries: [] }),
  name: "memory",
  staged: true,
};

/** Every built-in factory with its canonical metadata. */
const BUILT_IN: {
  adapter: AnySourceAdapter;
  deps: string[];
  secrets: string[];
}[] = [
  {
    adapter: filesystem({ root: "docs" }),
    deps: [],
    secrets: [],
  },
  {
    adapter: mdxRemote({ github: { owner: "acme", repo: "sdk" } }),
    deps: [],
    secrets: ["GITHUB_TOKEN"],
  },
  {
    adapter: githubReleases({ owner: "acme", repo: "sdk" }),
    deps: [],
    secrets: ["GITHUB_TOKEN"],
  },
  {
    adapter: sanity({ dataset: "production", projectId: "p1", query: "*" }),
    deps: ["@sanity/client"],
    secrets: ["SANITY_TOKEN"],
  },
  {
    adapter: notion({ database: "db1" }),
    deps: ["@notionhq/client"],
    secrets: ["NOTION_TOKEN"],
  },
  {
    adapter: obsidian({ vault: "vault" }),
    deps: [],
    secrets: [],
  },
];

const parse = (sources: unknown[]) =>
  blumeConfigSchema.parse({ content: { sources } });

/** A config whose `content.sources` is deliberately not a valid adapter list. */
interface InvalidSourcesConfig {
  content: {
    sources: unknown;
    exclude?: string[];
    include?: string[];
    root?: string;
  };
}

/** The issues a deliberately invalid config fails with. */
const issuesOf = (input: InvalidSourcesConfig) => {
  const result = blumeConfigSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.join("."),
      }));
};

// SAFETY: resolveSources reads only root, contentRoot, and outDir from the
// project context; the remaining fields are never touched.
const context = {
  contentRoot: "/p/docs",
  outDir: "/p/.blume",
  root: "/p",
} as ProjectContext;

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-source-adapters-"));
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

describe("blume/sources factories", () => {
  it("return a plain descriptor with the options verbatim", () => {
    for (const { adapter, deps, secrets } of BUILT_IN) {
      expect(adapter.requiredSecrets).toStrictEqual(secrets);
      expect(adapter.runtimeDeps).toStrictEqual(deps);
      // Plain data: a structured clone (which rejects functions) is identical.
      expect(structuredClone(adapter)).toStrictEqual(adapter);
    }
    const options = { prefix: "guides", root: "content" };
    expect(filesystem(options).options).toBe(options);
    expect(filesystem()).toStrictEqual({
      kind: "filesystem",
      options: {},
      requiredSecrets: [],
      runtimeDeps: [],
    });
  });

  it("custom() wraps the ContentSource instance as its options", () => {
    expect(custom(memory)).toStrictEqual({
      kind: "custom",
      options: memory,
      requiredSecrets: [],
      runtimeDeps: [],
    });
  });
});

describe("content.sources schema", () => {
  it("validates each factory's descriptor and applies option defaults", () => {
    const config = parse([
      ...BUILT_IN.map(({ adapter }) => adapter),
      custom(memory),
    ]);
    expect(config.content.sources.map((source) => source.kind)).toStrictEqual([
      "filesystem",
      "mdx-remote",
      "github-releases",
      "sanity",
      "notion",
      "obsidian",
      "custom",
    ]);
    const [fs, remote] = config.content.sources;
    const instance = config.content.sources.at(-1);
    expect(fs?.options).toStrictEqual({
      exclude: ["**/_*", "**/.*"],
      include: ["**/*.{md,mdx}"],
      root: "docs",
    });
    expect(remote?.options).toStrictEqual({
      github: { owner: "acme", path: "", ref: "main", repo: "sdk" },
      include: ["**/*.{md,mdx}"],
    });
    // The custom() instance is kept by reference: it carries functions.
    expect(instance?.options).toBe(memory);
  });

  it("re-derives runtimeDeps and requiredSecrets from the factory", () => {
    // A descriptor serialized by an older Blume (or edited by hand) resolves
    // to the metadata this version ships, not whatever it carried.
    const stale = {
      ...notion({ database: "db1" }),
      requiredSecrets: ["X"],
      runtimeDeps: [],
    };
    expect(parse([stale]).content.sources[0]).toStrictEqual(
      notion({ database: "db1" })
    );
  });

  it("accepts the shared prefix and pollInterval on every built-in adapter", () => {
    for (const { adapter } of BUILT_IN) {
      const shared = { pollInterval: 30, prefix: "p" };
      const [source] = parse([
        { ...adapter, options: { ...adapter.options, ...shared } },
      ]).content.sources;
      expect(source?.options).toMatchObject(shared);
    }
  });

  it("validates an adapter's options and points at the missing one", () => {
    const paths = issuesOf({
      content: {
        sources: [
          {
            ...sanity({ dataset: "d", projectId: "p", query: "*" }),
            options: { dataset: "d" },
          },
        ],
      },
    }).map((issue) => issue.path);
    expect(paths).toContain("content.sources.0.options.projectId");
    expect(paths).toContain("content.sources.0.options.query");
  });

  it("rejects an unknown option key and an unknown adapter kind", () => {
    // SAFETY: the unknown key is the point — the factory's type rejects it,
    // and this checks the schema rejects it at runtime too.
    const unknownKey = { rootDir: "x" } as never;
    expect(
      issuesOf({
        content: { sources: [filesystem(unknownKey)] },
      }).map((issue) => issue.path)
    ).toContain("content.sources.0.options");
    expect(
      issuesOf({ content: { sources: [{ ...filesystem(), kind: "ftp" }] } })
    ).not.toHaveLength(0);
  });

  it("rejects a custom() options that is not a ContentSource", () => {
    const issues = issuesOf({
      content: { sources: [{ ...custom(memory), options: { name: "x" } }] },
    });
    expect(issues[0]?.path).toBe("content.sources.0.options");
    expect(issues[0]?.message).toContain("name + load");
  });

  it("reports a 1.x type object with the factory that replaces it", () => {
    const cases = [
      [
        { owner: "acme", repo: "sdk", type: "github-releases" },
        "githubReleases({ … })",
      ],
      [{ type: "mdx-remote", url: "https://x" }, "mdxRemote({ … })"],
      [{ root: "docs", type: "filesystem" }, "filesystem({ … })"],
      [{ source: memory, type: "custom" }, "custom(source)"],
      [
        { type: "elastic" },
        'The 1.x { type: "elastic" } object form was removed.',
      ],
    ] as const;
    for (const [entry, expected] of cases) {
      const [issue] = issuesOf({ content: { sources: [entry] } });
      expect(issue?.path).toBe("content.sources.0");
      expect(issue?.message).toContain('"blume/sources"');
      expect(issue?.message).toContain(expected);
    }
  });

  it("reports a non-descriptor entry and a non-array with hints", () => {
    for (const entry of ["filesystem", null, 1]) {
      const [issue] = issuesOf({ content: { sources: [entry] } });
      expect(issue?.message).toContain("filesystem({ root })");
      expect(issue?.message).not.toContain("1.x");
    }
    const [issue] = issuesOf({ content: { sources: filesystem() } });
    expect(issue?.path).toBe("content.sources");
    expect(issue?.message).toContain("list of adapters");
  });
});

describe("content shorthand", () => {
  it("desugars an absent sources to one filesystem() source with defaults", () => {
    const config = blumeConfigSchema.parse({});
    expect(config.content.sources).toStrictEqual([
      {
        kind: "filesystem",
        options: {
          exclude: ["**/_*", "**/.*"],
          include: ["**/*.{md,mdx}"],
          root: "docs",
        },
        requiredSecrets: [],
        runtimeDeps: [],
      },
    ]);
    // The shorthand fields do not survive into the resolved config.
    expect(Object.keys(config.content).toSorted()).toStrictEqual([
      "defaultType",
      "pages",
      "sources",
      "types",
    ]);
  });

  it("desugars root/include/exclude into that source", () => {
    const config = blumeConfigSchema.parse({
      content: {
        exclude: ["drafts/**"],
        include: ["**/*.mdx"],
        root: "content",
      },
    });
    expect(config.content.sources).toStrictEqual([
      {
        kind: "filesystem",
        options: {
          exclude: ["drafts/**"],
          include: ["**/*.mdx"],
          root: "content",
        },
        requiredSecrets: [],
        runtimeDeps: [],
      },
    ]);
  });

  it("rejects the shorthand beside sources, naming each field", () => {
    const issues = issuesOf({
      content: {
        exclude: ["x"],
        include: ["y"],
        root: "docs",
        sources: [filesystem({ root: "docs" })],
      },
    });
    expect(issues.map((issue) => issue.path)).toStrictEqual([
      "content.exclude",
      "content.include",
      "content.root",
    ]);
    for (const issue of issues) {
      expect(issue.message).toContain("can't be combined with content.sources");
      expect(issue.message).toContain("filesystem({");
    }
  });

  it("accepts sources alone", () => {
    expect(
      parse([filesystem({ root: "content" })]).content.sources
    ).toHaveLength(1);
  });
});

describe("resolveDocsCollection", () => {
  it("roots the collection at the implicit source for a zero-config project", () => {
    const config = blumeConfigSchema.parse({});
    expect(resolveDocsCollection(config, "/p")).toStrictEqual({
      base: "/p/docs",
      exclude: ["**/_*", "**/.*"],
      include: ["**/*.{md,mdx}"],
    });
  });

  it("uses a lone filesystem source's own root and globs", () => {
    const config = parse([
      githubReleases({ owner: "a", prefix: "changelog", repo: "b" }),
      filesystem({
        exclude: ["vault/**"],
        include: ["**/*.mdx"],
        root: "/abs",
      }),
    ]);
    expect(resolveDocsCollection(config, "/p")).toStrictEqual({
      base: "/abs",
      exclude: ["vault/**"],
      include: ["**/*.mdx"],
    });
    // The project context's content root is that same base.
    expect(resolveProjectContext("/p", config).contentRoot).toBe("/abs");
  });

  it("unions includes and intersects excludes across filesystem sources sharing a root", () => {
    const config = parse([
      filesystem({
        exclude: ["**/_*", "vault/**"],
        include: ["docs/**"],
        root: ".",
      }),
      filesystem({
        exclude: ["**/_*"],
        include: ["guides/**", "docs/**"],
        prefix: "guides",
        root: ".",
      }),
    ]);
    expect(resolveDocsCollection(config, "/p")).toStrictEqual({
      base: "/p",
      exclude: ["**/_*"],
      include: ["docs/**", "guides/**"],
    });
  });

  it("anchors an all-staged project at the default docs directory", () => {
    const config = parse([custom(memory)]);
    expect(resolveDocsCollection(config, "/p")).toStrictEqual({
      base: "/p/docs",
      exclude: ["**/_*", "**/.*"],
      include: ["**/*.{md,mdx}"],
    });
  });

  it("filters sources by kind", () => {
    const config = parse([
      filesystem(),
      custom(memory),
      filesystem({ root: "x" }),
    ]);
    expect(sourcesOfKind(config, "filesystem")).toHaveLength(2);
    expect(sourcesOfKind(config, "custom")[0]?.options).toBe(memory);
    expect(sourcesOfKind(config, "notion")).toStrictEqual([]);
  });
});

describe("resolveSources", () => {
  it("instantiates every adapter kind, named after its prefix or kind", () => {
    const config = parse([
      filesystem({ root: "docs" }),
      mdxRemote({ files: ["a.md"], prefix: "sdk", url: "https://x" }),
      githubReleases({ owner: "a", repo: "b" }),
      sanity({ dataset: "d", projectId: "p", query: "*" }),
      notion({ database: "db", prefix: "handbook" }),
      obsidian({ pollInterval: 5, vault: "vault" }),
      custom(memory),
      custom({ ...memory }),
    ]);
    const sources = resolveSources(config, context, { mode: "build" });
    expect(sources.map((source) => source.name)).toStrictEqual([
      "filesystem",
      "sdk",
      "github-releases",
      "sanity",
      "handbook",
      "obsidian",
      "memory",
      "memory-2",
    ]);
    expect(sources.map((source) => source.staged)).toStrictEqual([
      false,
      ...Array.from({ length: 7 }, () => true),
    ]);
    // The first custom instance is passed through untouched; the second is
    // renamed to keep ids unique.
    expect(sources[6]).toBe(memory);
    expect(sources[7]).not.toBe(memory);
  });

  it("threads the filesystem options through to the source", () => {
    const config = parse([
      filesystem({ pollInterval: 5, prefix: "docs", root: "content" }),
    ]);
    const [source] = resolveSources(config, context, { mode: "build" });
    expect(source?.prefix).toBe("docs");
    expect(source?.contentRoot).toBe("/p/content");
  });
});

describe("descriptor consumers", () => {
  const KEYS = ["GITHUB_TOKEN", "NOTION_TOKEN", "SANITY_TOKEN"];
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("declares each source's SDK in the generated package.json, once", () => {
    const config = parse([
      notion({ database: "a" }),
      notion({ database: "b", prefix: "b" }),
      sanity({ dataset: "d", projectId: "p", query: "*" }),
      filesystem(),
    ]);
    const deps = runtimeDependencies({ config, needsReact: false });
    expect(deps.filter((dep) => dep === "@notionhq/client")).toHaveLength(1);
    expect(deps).toContain("@sanity/client");
    expect(
      runtimeDependencies({
        config: blumeConfigSchema.parse({}),
        needsReact: false,
      })
    ).not.toContain("@notionhq/client");
  });

  it("warns for each unset secret an adapter declares", () => {
    for (const key of KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
    const config = parse([
      filesystem(),
      githubReleases({ owner: "a", repo: "b" }),
      notion({ database: "db" }),
      sanity({ dataset: "d", projectId: "p", query: "*" }),
    ]);
    const messages = checkRequiredSecrets(config).map((d) => d.message);
    expect(messages).toStrictEqual([
      "Content source (github-releases) is enabled but GITHUB_TOKEN is not set.",
      "Content source (notion) is enabled but NOTION_TOKEN is not set.",
      "Content source (sanity) is enabled but SANITY_TOKEN is not set.",
    ]);
    for (const key of KEYS) {
      process.env[key] = "set";
    }
    expect(checkRequiredSecrets(config)).toStrictEqual([]);
  });

  it("warns when an adapter's SDK cannot be resolved", async () => {
    const root = await makeProject({});
    const config = parse([filesystem(), notion({ database: "db" })]);
    const warnings = sourceAdapterWarnings(config.content.sources, root, root);
    expect(warnings).toStrictEqual([
      'Content source "notion" needs "@notionhq/client", which isn\'t installed. Run `npm install @notionhq/client` (or your package manager\'s equivalent).',
    ]);
    expect(
      sourceAdapterWarnings(
        blumeConfigSchema.parse({}).content.sources,
        root,
        root
      )
    ).toStrictEqual([]);
  });

  it("re-roots every filesystem source for --content-dir and leaves the rest", async () => {
    const root = await makeProject({
      "blume.config.ts": `const memory = {
  load: () => Promise.resolve({ diagnostics: [], entries: [] }),
  name: "memory",
  staged: true,
};
export default {
  content: {
    sources: [
      ${JSON.stringify(filesystem({ root: "docs" }))},
      ${JSON.stringify(filesystem({ include: ["**/*.mdx"], prefix: "more", root: "docs" }))},
      { kind: "custom", options: memory, requiredSecrets: [], runtimeDeps: [] },
    ],
  },
};
`,
      "guides/index.md": "# Home\n",
    });
    const project = await scanProject(root, {
      mode: "build",
      overrides: { contentRoot: "guides" },
    });
    expect(
      project.config.content.sources.map((source) =>
        source.kind === "filesystem" ? source.options.root : source.kind
      )
    ).toStrictEqual(["guides", "guides", "custom"]);
    expect(project.context.contentRoot).toBe(join(root, "guides"));
    expect(project.manifest.routes.map((route) => route.path)).toStrictEqual([
      "/",
    ]);
  });
});

describe("blume sync", () => {
  const run = async (root: string, ...args: string[]) => {
    const proc = Bun.spawn([process.execPath, CLI, "sync", ...args], {
      cwd: root,
      // bun test exports NODE_ENV=test, which drops consola's default level to
      // warnings-only in the child — raise it so success output is visible.
      env: { ...process.env, CONSOLA_LEVEL: "3" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, output: stdout + stderr };
  };

  const fixture = async () =>
    await makeProject({
      // The remote source's URL is unreachable, so the refresh falls back to
      // the seeded snapshot — which is what `blume sync` re-materializes.
      ".blume/cache/sdk/entries.json": JSON.stringify([
        {
          body: { format: "mdx", text: "# Intro\n" },
          data: { title: "Intro" },
          raw: "---\ntitle: Intro\n---\n# Intro\n",
          ref: "intro.mdx",
        },
      ]),
      "blume.config.ts": `export default {
  content: {
    sources: [
      ${JSON.stringify(filesystem({ root: "docs" }))},
      ${JSON.stringify(mdxRemote({ files: ["intro.mdx"], prefix: "sdk", url: "http://127.0.0.1:1" }))},
    ],
  },
};
`,
      "docs/index.md": "# Home\n",
    });

  it("refreshes the adapter-configured remote source into the staged collection", async () => {
    const root = await fixture();
    const { exitCode, output } = await run(root);
    expect(exitCode).toBe(0);
    expect(output).toContain("Synced content sources.");
    expect(existsSync(join(root, ".blume/content/sdk/intro.mdx"))).toBe(true);
  }, 60_000);

  it("clears the source cache first with --force, so an unreachable remote is an error", async () => {
    const root = await fixture();
    const { exitCode, output } = await run(root, "--force");
    expect(output).toContain("Cleared source cache.");
    expect(existsSync(join(root, ".blume/cache/sdk/entries.json"))).toBe(false);
    // With no snapshot left to fall back on, the failed fetch surfaces
    // instead of a stale page.
    expect(output).toContain("BLUME_SOURCE_FETCH_FAILED");
    expect(exitCode).toBe(1);
  }, 60_000);
});
