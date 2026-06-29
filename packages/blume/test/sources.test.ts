import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import { contentConfigTemplate } from "../src/astro/templates.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { entriesDigest } from "../src/core/sources/cache.ts";
import { filesystemSource } from "../src/core/sources/filesystem.ts";
import { mdxRemoteSource } from "../src/core/sources/mdx-remote.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";
import type { SourceContext, SourceEntry } from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";
import { eject } from "../src/registry/eject.ts";

const dirs: string[] = [];

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-sources-"));
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

/** A minimal Response-like for the injected fetch. */
const ok = (text: string): Response =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(text),
  }) as unknown as Response;
const okJson = (value: unknown): Response =>
  ({
    json: () => Promise.resolve(value),
    ok: true,
    status: 200,
  }) as unknown as Response;
const notFound = (): Response =>
  ({
    ok: false,
    status: 404,
    text: () => Promise.resolve(""),
  }) as unknown as Response;

const ctxFor = (cacheDir: string): SourceContext => ({
  cacheDir,
  mode: "build",
  projectRoot: cacheDir,
});

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("filesystemSource", () => {
  it("discovers files into normalized entries and reads them back", async () => {
    const root = await makeProject({
      "docs/guide/setup.md": "---\ntitle: Setup\n---\n# Setup\n",
      "docs/index.mdx": "# Home\n",
    });
    const source = filesystemSource({
      exclude: [],
      include: ["**/*.{md,mdx}"],
      name: "filesystem",
      projectRoot: root,
      root: "docs",
    });

    const { entries } = await source.load();
    const byRef = new Map(entries.map((entry) => [entry.ref, entry]));

    expect([...byRef.keys()].toSorted()).toStrictEqual([
      "guide/setup.md",
      "index.mdx",
    ]);
    expect(byRef.get("index.mdx")?.body.format).toBe("mdx");
    expect(byRef.get("guide/setup.md")?.body.format).toBe("md");
    expect(byRef.get("guide/setup.md")?.sourcePath).toBe(
      join(root, "docs/guide/setup.md")
    );
    expect(await source.read?.("index.mdx")).toContain("# Home");
  });

  it("validate throws BLUME_CONTENT_ROOT_MISSING for an absent root", async () => {
    const root = await makeProject({ "README.md": "# none\n" });
    const source = filesystemSource({
      exclude: [],
      include: ["**/*.md"],
      name: "filesystem",
      projectRoot: root,
      root: "docs",
    });
    expect(() => source.validate?.()).toThrow();
  });
});

describe("normalizeEntry", () => {
  const fsEntry: SourceEntry = {
    body: { format: "md", text: "# Setup\n" },
    data: {},
    ref: "guide/setup.md",
    sourcePath: "/abs/guide/setup.md",
  };

  it("namespaces the id and keeps filesystem entries off the staging path", () => {
    const { pages } = normalizeEntry(fsEntry, {
      defaultType: "doc",
      source: { name: "filesystem", staged: false },
    });
    const [page] = pages;
    expect(page?.id).toBe("filesystem:guide/setup.md");
    expect(page?.source).toStrictEqual({
      name: "filesystem",
      ref: "guide/setup.md",
    });
    expect(page?.route).toBe("/guide/setup");
    expect(page?.collection).toBeUndefined();
    expect(page?.body).toBeUndefined();
    expect(page?.sourcePath).toBe("/abs/guide/setup.md");
  });

  it("prefixes routes and stages the full raw body for non-filesystem sources", () => {
    const entry: SourceEntry = {
      body: { format: "mdx", text: "# Intro\n" },
      data: { title: "Intro" },
      editUrl: "https://example.com/edit/intro.mdx",
      raw: "---\ntitle: Intro\n---\n# Intro\n",
      ref: "intro.mdx",
    };
    const { pages } = normalizeEntry(entry, {
      defaultType: "doc",
      source: { name: "sdk", prefix: "sdk", staged: true },
    });
    const [page] = pages;
    expect(page?.id).toBe("sdk:intro.mdx");
    expect(page?.route).toBe("/sdk/intro");
    expect(page?.collection).toBe("staged");
    expect(page?.entryId).toBe("sdk/intro.mdx");
    expect(page?.body?.text).toBe("---\ntitle: Intro\n---\n# Intro\n");
    expect(page?.editUrl).toBe("https://example.com/edit/intro.mdx");
    expect(page?.title).toBe("Intro");
  });

  it("reports a diagnostic for invalid frontmatter", () => {
    const { pages, diagnostics } = normalizeEntry(
      {
        body: { format: "md", text: "# Bad\n" },
        data: { draft: "maybe" },
        ref: "bad.md",
      },
      { defaultType: "doc", source: { name: "filesystem", staged: false } }
    );
    expect(pages).toHaveLength(0);
    expect(diagnostics.map((d) => d.code)).toContain(
      "BLUME_FRONTMATTER_INVALID"
    );
  });
});

describe("mdxRemoteSource (files mode)", () => {
  const FILES: Record<string, string> = {
    "guide.md": "---\ntitle: Guide\n---\n# Guide\n",
    "intro.mdx": "---\ntitle: Intro\n---\n# Intro\n",
    "notes.txt": "ignored\n",
  };

  const fetchOk = ((input: string | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const ref = url.split("/").pop() ?? "";
    return Promise.resolve(FILES[ref] ? ok(FILES[ref]) : notFound());
  }) as unknown as typeof fetch;

  it("fetches included refs, strips frontmatter, and keeps the raw for staging", async () => {
    const cacheDir = join(await makeProject({}), ".cache");
    const source = mdxRemoteSource(
      {
        fetchImpl: fetchOk,
        files: ["intro.mdx", "guide.md", "notes.txt"],
        include: ["**/*.{md,mdx}"],
        name: "sdk",
        prefix: "sdk",
        url: "https://example.com/docs",
      },
      ctxFor(cacheDir)
    );

    const { entries, diagnostics } = await source.load();
    expect(diagnostics).toHaveLength(0);
    const refs = entries.map((entry) => entry.ref).toSorted();
    // notes.txt is filtered out by the include globs.
    expect(refs).toStrictEqual(["guide.md", "intro.mdx"]);

    const intro = entries.find((entry) => entry.ref === "intro.mdx");
    expect(intro?.body.text.trim()).toBe("# Intro");
    expect(intro?.raw).toContain("title: Intro");
    expect(intro?.editUrl).toBe("https://example.com/docs/intro.mdx");
    expect(await source.read?.("intro.mdx")).toContain("title: Intro");
  });

  it("falls back to the cached snapshot when the fetch fails", async () => {
    const cacheDir = join(await makeProject({}), ".cache");
    const opts = {
      files: ["intro.mdx", "guide.md"],
      include: ["**/*.{md,mdx}"],
      name: "sdk",
      url: "https://example.com/docs",
    };

    // First load primes the cache.
    await mdxRemoteSource(
      { ...opts, fetchImpl: fetchOk },
      ctxFor(cacheDir)
    ).load();

    const failing = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const offline = mdxRemoteSource(
      { ...opts, fetchImpl: failing },
      ctxFor(cacheDir)
    );
    const { entries, diagnostics } = await offline.load();

    expect(entries).toHaveLength(2);
    expect(diagnostics.map((d) => d.code)).toContain("BLUME_SOURCE_OFFLINE");
  });
});

describe("mdxRemoteSource (github mode)", () => {
  it("enumerates a repo subtree and fetches raw blobs", async () => {
    const tree = {
      tree: [
        { path: "docs/intro.mdx", type: "blob" },
        { path: "docs/nested/deep.md", type: "blob" },
        { path: "docs/logo.png", type: "blob" },
        { path: "README.md", type: "blob" },
      ],
    };
    const fetchImpl = ((input: string | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.github.com")) {
        return Promise.resolve(okJson(tree));
      }
      return Promise.resolve(
        ok(`---\ntitle: ${url.split("/").pop()}\n---\nbody\n`)
      );
    }) as unknown as typeof fetch;

    const cacheDir = join(await makeProject({}), ".cache");
    const source = mdxRemoteSource(
      {
        fetchImpl,
        github: { owner: "acme", path: "docs", ref: "main", repo: "sdk" },
        include: ["**/*.{md,mdx}"],
        name: "sdk",
        prefix: "sdk",
      },
      ctxFor(cacheDir)
    );

    const { entries } = await source.load();
    // README.md (outside `docs/`) and logo.png (not md/mdx) are excluded.
    expect(entries.map((entry) => entry.ref).toSorted()).toStrictEqual([
      "intro.mdx",
      "nested/deep.md",
    ]);
  });
});

describe("scanProject composition", () => {
  const withConfig = async (
    files: Record<string, string>,
    config: string
  ): Promise<string> => {
    const root = await makeProject(files);
    await writeFile(join(root, "blume.config.ts"), config);
    return root;
  };

  it("merges multiple filesystem sources and namespaces by prefix", async () => {
    const root = await withConfig(
      {
        "api/auth.md": "---\ntitle: Auth\n---\n# Auth\n",
        "api/index.md": "---\ntitle: API\n---\n# API\n",
        "docs/index.md": "# Home\n",
      },
      `export default {
        content: {
          sources: [
            { type: "filesystem", root: "docs" },
            { type: "filesystem", root: "api", prefix: "api" },
          ],
        },
      };\n`
    );

    const project = await scanProject(root, { mode: "build" });
    const paths = project.manifest.routes.map((route) => route.path).toSorted();
    expect(paths).toStrictEqual(["/", "/api", "/api/auth"]);
    expect(project.sources.map((source) => source.name)).toStrictEqual([
      "filesystem",
      "api",
    ]);
  });

  it("flags a cross-source route collision", async () => {
    const root = await withConfig(
      { "a/index.md": "# A\n", "b/index.md": "# B\n" },
      `export default {
        content: {
          root: "a",
          sources: [
            { type: "filesystem", root: "a" },
            { type: "filesystem", root: "b" },
          ],
        },
      };\n`
    );

    const project = await scanProject(root, { mode: "build" });
    expect(project.diagnostics.map((d) => d.code)).toContain(
      "BLUME_DUPLICATE_ROUTE"
    );
  });

  it("merges a user-provided custom ContentSource", async () => {
    const root = await withConfig(
      { "docs/index.md": "# Home\n" },
      `const memory = {
        name: "memory",
        prefix: "mem",
        staged: true,
        load: () => Promise.resolve({
          diagnostics: [],
          entries: [{
            ref: "hello.md",
            data: { title: "Hi" },
            body: { format: "md", text: "# Hi" },
            raw: "# Hi",
          }],
        }),
        read: () => Promise.resolve("# Hi"),
      };
      export default {
        content: {
          sources: [
            { type: "filesystem", root: "docs" },
            { type: "custom", source: memory },
          ],
        },
      };\n`
    );

    const project = await scanProject(root, { mode: "build" });
    const route = project.manifest.routes.find((r) => r.path === "/mem/hello");
    expect(route?.collection).toBe("staged");
    expect(route?.entryId).toBe("memory/hello.md");
    expect(route?.source.name).toBe("memory");
  });
});

const noop = () => {
  // intentionally empty change handler
};

const digestEntry = (ref: string, hash: string): SourceEntry => ({
  body: { format: "md", text: "x" },
  data: {},
  hash,
  ref,
});

describe("remote watch", () => {
  it("entriesDigest is stable for unchanged entries and shifts on change", () => {
    const a = [digestEntry("a.md", "1"), digestEntry("b.md", "2")];
    expect(entriesDigest(a)).toBe(entriesDigest([...a]));
    expect(entriesDigest(a)).not.toBe(
      entriesDigest([digestEntry("a.md", "1"), digestEntry("b.md", "9")])
    );
  });

  it("exposes watch only when a poll interval is configured", () => {
    const base = {
      files: ["a.mdx"],
      include: ["**/*.mdx"],
      name: "sdk",
      url: "https://example.com",
    };
    const ctx: SourceContext = {
      cacheDir: "/tmp/x",
      mode: "dev",
      projectRoot: "/tmp",
    };
    expect(mdxRemoteSource(base, ctx).watch).toBeUndefined();
    expect(
      typeof mdxRemoteSource({ ...base, pollInterval: 30 }, ctx).watch
    ).toBe("function");
  });

  it("serves the cache without fetching when refresh is false", async () => {
    const dir = await makeProject({});
    const cacheDir = join(dir, ".cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "entries.json"),
      JSON.stringify([
        {
          body: { format: "mdx", text: "# A" },
          data: {},
          raw: "# A",
          ref: "a.mdx",
        },
      ])
    );
    const failing = (() =>
      Promise.reject(new Error("should not fetch"))) as unknown as typeof fetch;
    const source = mdxRemoteSource(
      {
        fetchImpl: failing,
        files: ["a.mdx"],
        include: ["**/*.mdx"],
        name: "sdk",
        url: "https://example.com",
      },
      { cacheDir, mode: "dev", projectRoot: dir, refresh: false }
    );
    const { entries, diagnostics } = await source.load();
    // Cache-first (not a fallback), so the entry is served with no diagnostic.
    expect(entries).toHaveLength(1);
    expect(diagnostics).toHaveLength(0);
  });
});

describe("filesystemSource watch", () => {
  it("watches an existing root and returns a disposer", async () => {
    const root = await makeProject({ "docs/index.md": "# Home\n" });
    const source = filesystemSource({
      exclude: [],
      include: ["**/*.md"],
      name: "filesystem",
      projectRoot: root,
      root: "docs",
    });
    const dispose = source.watch?.(noop);
    expect(typeof dispose).toBe("function");
    expect(() => dispose?.()).not.toThrow();
  });

  it("is a no-op disposer when the root does not exist", async () => {
    const root = await makeProject({});
    const source = filesystemSource({
      exclude: [],
      include: ["**/*.md"],
      name: "filesystem",
      projectRoot: root,
      root: "missing",
    });
    const dispose = source.watch?.(noop);
    expect(typeof dispose).toBe("function");
    expect(() => dispose?.()).not.toThrow();
  });
});

describe("contentConfigTemplate", () => {
  const context = {
    contentRoot: "/p/docs",
    outDir: "/p/.blume",
  } as ProjectContext;
  const config = { content: { include: ["**/*.{md,mdx}"] } } as never;

  it("emits only the docs collection without staged sources", () => {
    const out = contentConfigTemplate({ config, context });
    expect(out).toContain("export const collections = { docs };");
    expect(out).not.toContain("staged");
  });

  it("emits a parallel staged collection when staged sources exist", () => {
    const out = contentConfigTemplate({ config, context, staged: true });
    expect(out).toContain("const staged = defineCollection(");
    expect(out).toContain("/p/.blume/content");
    expect(out).toContain("export const collections = { docs, staged };");
  });
});

describe("staging end to end", () => {
  it("materializes a remote source into .blume/content and wires the collection", async () => {
    const root = await makeProject({ "docs/index.md": "# Home\n" });
    await writeFile(
      join(root, "blume.config.ts"),
      `export default {
        content: {
          sources: [
            { type: "filesystem", root: "docs" },
            { type: "mdx-remote", prefix: "sdk", url: "http://127.0.0.1:1", files: ["intro.mdx"] },
          ],
        },
      };\n`
    );
    // Seed the cache so the unreachable URL serves a known-good snapshot offline.
    const seed: SourceEntry[] = [
      {
        body: { format: "mdx", text: "# Intro\n" },
        data: { title: "Intro" },
        raw: "---\ntitle: Intro\n---\n# Intro\n",
        ref: "intro.mdx",
      },
    ];
    const cacheDir = join(root, ".blume/cache/sdk");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "entries.json"), JSON.stringify(seed));

    const project = await scanProject(root, { mode: "build" });
    const sdk = project.manifest.routes.find((r) => r.path === "/sdk/intro");
    expect(sdk?.collection).toBe("staged");
    expect(sdk?.entryId).toBe("sdk/intro.mdx");

    await generateRuntime(project);
    const staged = await readFile(
      join(root, ".blume/content/sdk/intro.mdx"),
      "utf-8"
    );
    expect(staged).toContain("title: Intro");
    const contentConfig = await readFile(
      join(root, ".blume/src/content.config.ts"),
      "utf-8"
    );
    expect(contentConfig).toContain("const staged = defineCollection(");
  });

  it("ejects staged content into a dedicated dir with a portable collection base", async () => {
    const root = await makeProject({ "docs/index.md": "# Home\n" });
    await writeFile(
      join(root, "blume.config.ts"),
      `export default {
        content: {
          sources: [
            { type: "filesystem", root: "docs" },
            { type: "mdx-remote", prefix: "sdk", url: "http://127.0.0.1:1", files: ["intro.mdx"] },
          ],
        },
      };\n`
    );
    const seed: SourceEntry[] = [
      {
        body: { format: "mdx", text: "# Intro\n" },
        data: { title: "Intro" },
        raw: "---\ntitle: Intro\n---\n# Intro\n",
        ref: "intro.mdx",
      },
    ];
    const cacheDir = join(root, ".blume/cache/sdk");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "entries.json"), JSON.stringify(seed));

    await eject(root);

    const ejectedConfig = await readFile(
      join(root, "src/content.config.ts"),
      "utf-8"
    );
    expect(ejectedConfig).toContain('base: "blume-staged"');
    expect(ejectedConfig).toContain(
      "export const collections = { docs, staged }"
    );

    const staged = await readFile(
      join(root, "blume-staged/sdk/intro.mdx"),
      "utf-8"
    );
    expect(staged).toContain("title: Intro");
  });
});
