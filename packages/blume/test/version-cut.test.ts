import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { scanProject } from "../src/core/project-graph.ts";
import {
  CutError,
  cutVersion,
  insertArchivedVersion,
  insertVersionsBlock,
  rewriteSnapshotLinks,
  unregisteredSnapshotDiagnostics,
} from "../src/core/version-cut.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** Write a project (blume.config.ts + docs tree) into a fresh temp root. */
const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-version-cut-"));
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

const VERSIONED_CONFIG = `export default {
  versions: {
    archived: [{ id: "v1.0" }],
    current: { label: "v2.0" },
  },
};
`;

describe("rewriteSnapshotLinks", () => {
  const rewrites = new Map([
    ["/", "/v2.0"],
    ["/guides/x", "/v2.0/guides/x"],
  ]);

  it("rewrites markdown links, images, and href attributes", () => {
    const { text, count } = rewriteSnapshotLinks(
      'See [X](/guides/x) and <a href="/guides/x">X</a> and ![shot](/guides/x).',
      rewrites
    );
    expect(text).toBe(
      'See [X](/v2.0/guides/x) and <a href="/v2.0/guides/x">X</a> and ![shot](/v2.0/guides/x).'
    );
    expect(count).toBe(1);
  });

  it("keeps anchors and queries attached and rewrites the root link", () => {
    const { text } = rewriteSnapshotLinks(
      "[X](/guides/x#setup) [X](/guides/x?tab=1) [home](/)",
      rewrites
    );
    expect(text).toBe(
      "[X](/v2.0/guides/x#setup) [X](/v2.0/guides/x?tab=1) [home](/v2.0)"
    );
  });

  it("leaves fenced code, inline code, and unknown targets alone", () => {
    const source = [
      "[known](/guides/x)",
      "`[inline](/guides/x)`",
      "```",
      "[fenced](/guides/x)",
      "```",
      "[unknown](/not-a-page) [external](https://example.com/guides/x)",
    ].join("\n");
    const { text, count } = rewriteSnapshotLinks(source, rewrites);
    expect(text).toContain("[known](/v2.0/guides/x)");
    expect(text).toContain("`[inline](/guides/x)`");
    expect(text).toContain("[fenced](/guides/x)");
    expect(text).toContain("[unknown](/not-a-page)");
    expect(text).toContain("https://example.com/guides/x");
    expect(count).toBe(1);
  });

  it("matches a trailing-slash spelling of a known route", () => {
    const { text } = rewriteSnapshotLinks("[X](/guides/x/)", rewrites);
    expect(text).toBe("[X](/v2.0/guides/x)");
  });
});

describe("insertArchivedVersion", () => {
  it("inserts at the head of a multiline archived array", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  versions: {
    archived: [
      { id: "v1.0" },
    ],
    current: { label: "v2.0" },
  },
};
`,
    });
    const path = join(root, "blume.config.ts");
    expect(await insertArchivedVersion(path, "v2.0")).toBe(true);
    const text = await readFile(path, "utf-8");
    expect(text).toContain(
      'archived: [\n      { id: "v2.0" },\n      { id: "v1.0" },'
    );
  });

  it("keeps a CRLF config's line endings when inserting", async () => {
    const root = await makeProject({
      "blume.config.ts": [
        "export default {",
        "  versions: {",
        "    archived: [",
        '      { id: "v1.0" },',
        "    ],",
        '    current: { label: "v2.0" },',
        "  },",
        "};",
        "",
      ].join("\r\n"),
    });
    const path = join(root, "blume.config.ts");
    expect(await insertArchivedVersion(path, "v2.0")).toBe(true);
    const text = await readFile(path, "utf-8");
    expect(text).toContain(
      'archived: [\r\n      { id: "v2.0" },\r\n      { id: "v1.0" },'
    );
    // No lone LF was introduced.
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("inserts inline into an inline array", async () => {
    const root = await makeProject({ "blume.config.ts": VERSIONED_CONFIG });
    const path = join(root, "blume.config.ts");
    expect(await insertArchivedVersion(path, "v2.0")).toBe(true);
    expect(await readFile(path, "utf-8")).toContain(
      'archived: [{ id: "v2.0" }, { id: "v1.0" }]'
    );
  });

  it("fills an empty array without a dangling comma", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  versions: { archived: [], current: { label: "v2.0" } },
};
`,
    });
    const path = join(root, "blume.config.ts");
    expect(await insertArchivedVersion(path, "v1.0")).toBe(true);
    expect(await readFile(path, "utf-8")).toContain(
      'archived: [{ id: "v1.0" }]'
    );
  });

  it("returns false when no archived array literal exists", async () => {
    const root = await makeProject({
      "blume.config.ts": "export default {};\n",
    });
    expect(
      await insertArchivedVersion(join(root, "blume.config.ts"), "v1.0")
    ).toBe(false);
  });

  it("returns false when the config file is missing", async () => {
    const root = await makeProject({});
    expect(
      await insertArchivedVersion(join(root, "blume.config.ts"), "v1.0")
    ).toBe(false);
  });
});

const insert = async (config: string): Promise<string | false> => {
  const root = await makeProject({ "blume.config.ts": config });
  const path = join(root, "blume.config.ts");
  return (
    (await insertVersionsBlock(path, "v1.0")) && (await readFile(path, "utf-8"))
  );
};

describe("insertVersionsBlock", () => {
  it("adds the block as the first property of a defineConfig call", async () => {
    expect(
      await insert(
        'import { defineConfig } from "blume";\n\nexport default defineConfig({\n\ttitle: "Docs",\n});\n'
      )
    ).toBe(
      'import { defineConfig } from "blume";\n\nexport default defineConfig({\n\tversions: {\n\t  archived: [{ id: "v1.0" }],\n\t  current: { label: "Latest" },\n\t},\n\ttitle: "Docs",\n});\n'
    );
  });

  it("opens up an empty or inline object", async () => {
    expect(await insert("export default defineConfig({});\n")).toBe(
      'export default defineConfig({\n  versions: {\n    archived: [{ id: "v1.0" }],\n    current: { label: "Latest" },\n  },\n});\n'
    );
    expect(await insert('export default { title: "Docs" };\n')).toBe(
      'export default {\n  versions: {\n    archived: [{ id: "v1.0" }],\n    current: { label: "Latest" },\n  },\n  title: "Docs" };\n'
    );
  });

  it("keeps a CRLF config's line endings", async () => {
    const result = await insert(
      'export default {\r\n  title: "Docs",\r\n};\r\n'
    );
    expect(result).toContain(
      'versions: {\r\n    archived: [{ id: "v1.0" }],\r\n'
    );
    expect(String(result).replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("leaves a config it can't safely edit alone", async () => {
    expect(await insert("const config = {};\nexport default config;\n")).toBe(
      false
    );
    expect(
      await insert(
        'export default {\n  versions: undefined,\n  title: "Docs",\n};\n'
      )
    ).toBe(false);
    expect(
      await insert("export default defineConfig({});\nexport default {};\n")
    ).toBe(false);
    const root = await makeProject({});
    expect(
      await insertVersionsBlock(join(root, "blume.config.ts"), "v1.0")
    ).toBe(false);
  });
});

describe("unregisteredSnapshotDiagnostics", () => {
  it("warns about a version-shaped folder when versioning isn't configured", async () => {
    const root = await makeProject({
      "blume.config.ts": "const config = {};\nexport default config;\n",
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
      "docs/v1.0/guide.mdx": "---\ntitle: Old guide\n---\n# Old\n",
      "docs/v1.0/index.mdx": "---\ntitle: Old\n---\n# Old\n",
      "docs/versions.mdx": "---\ntitle: Versions\n---\n# Versions\n",
    });
    const diagnostics = unregisteredSnapshotDiagnostics(
      await scanProject(root)
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_VERSIONS_UNCONFIGURED_VERSION");
    expect(diagnostics[0]?.file).toBe(join(root, "docs", "v1.0"));
    expect(diagnostics[0]?.message).toContain('Folder "v1.0/"');
    expect(diagnostics[0]?.suggestion).toContain('archived: [{ id: "v1.0" }]');
  });

  it("leaves a versioned project to the scan's own check", async () => {
    const root = await makeProject({
      "blume.config.ts": VERSIONED_CONFIG,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
      "docs/v2.0/index.mdx": "---\ntitle: Stray\n---\n# Stray\n",
    });
    expect(unregisteredSnapshotDiagnostics(await scanProject(root))).toEqual(
      []
    );
  });
});

describe("cutVersion", () => {
  it("snapshots the tree, excludes prior snapshots, and rewrites links", async () => {
    const root = await makeProject({
      "blume.config.ts": VERSIONED_CONFIG,
      "docs/guides/meta.ts": 'export default { title: "Guides" };\n',
      "docs/guides/x.mdx": "---\ntitle: X\n---\n# X\n\n[Home](/)\n",
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n\n[X](/guides/x)\n",
      "docs/v1.0/index.mdx": "---\ntitle: Old\n---\n# Old\n",
    });

    const result = await cutVersion(root, "v2.0");

    expect(result.dir).toBe(join(root, "docs", "v2.0"));
    expect(existsSync(join(root, "docs/v2.0/index.mdx"))).toBe(true);
    expect(existsSync(join(root, "docs/v2.0/guides/x.mdx"))).toBe(true);
    // Non-markdown files (folder meta, assets) copy verbatim.
    expect(existsSync(join(root, "docs/v2.0/guides/meta.ts"))).toBe(true);
    // The existing snapshot never nests inside the new one.
    expect(existsSync(join(root, "docs/v2.0/v1.0"))).toBe(false);
    expect(result.copied).toBe(3);

    const home = await readFile(join(root, "docs/v2.0/index.mdx"), "utf-8");
    expect(home).toContain("[X](/v2.0/guides/x)");
    expect(result.rewritten).toHaveLength(2);

    expect(result.configUpdated).toBe(true);
    expect(await readFile(join(root, "blume.config.ts"), "utf-8")).toContain(
      '{ id: "v2.0" }, { id: "v1.0" }'
    );
  });

  it("rewrites locale-prefixed links inside a localized project", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  i18n: {
    defaultLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "fr", label: "Français" },
    ],
  },
  versions: { archived: [], current: { label: "v2.0" } },
};
`,
      "docs/fr/guides/x.mdx":
        "---\ntitle: X fr\n---\n# X\n\n[X](/fr/guides/x)\n",
      "docs/guides/x.mdx": "---\ntitle: X\n---\n# X\n",
    });

    await cutVersion(root, "v1.0");
    const french = await readFile(
      join(root, "docs/v1.0/fr/guides/x.mdx"),
      "utf-8"
    );
    // The version segment slots inside the locale prefix.
    expect(french).toContain("[X](/fr/v1.0/guides/x)");
  });

  it("leaves a staged source's pages alone even when its files sit under the content root", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  content: {
    sources: [
      { kind: "filesystem", options: { root: "docs", exclude: ["vault/**"] }, requiredSecrets: [], runtimeDeps: [] },
      { kind: "obsidian", options: { vault: "docs/vault" }, requiredSecrets: [], runtimeDeps: [] },
    ],
  },
  versions: { archived: [], current: { label: "v2.0" } },
};
`,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n\n[Note](/note)\n",
      "docs/vault/Note.md": "# Note\n\n[[Note]]\n",
    });
    const result = await cutVersion(root, "v1.0");
    // The vault note is served from the vault, not from the snapshot copy,
    // so it keeps publishing as current: a link to it is not versionized.
    const home = await readFile(join(root, "docs/v1.0/index.mdx"), "utf-8");
    expect(home).toContain("[Note](/note)");
    expect(result.rewritten).toEqual([]);
    // Nor is the vault copied: the filesystem source's root-anchored
    // `vault/**` exclude would not match `v1.0/vault/**`, and the snapshot
    // would publish the raw note — wikilink intact — as a page of its own.
    expect(existsSync(join(root, "docs/v1.0/vault"))).toBe(false);
    expect(result.copied).toBe(1);
  });

  it("falls back to an archived-entry snippet when the config resists surgery", async () => {
    const root = await makeProject({
      // The archived array is computed, so there is no `archived: [` literal
      // to splice into — the CLI prints the entry to paste instead.
      "blume.config.ts": `const archived = [{ id: "v1.0" }];
export default {
  versions: { archived, current: { label: "v2.0" } },
};
`,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
      "docs/v1.0/index.mdx": "---\ntitle: Old\n---\n# Old\n",
    });
    const result = await cutVersion(root, "v2.0");
    expect(result.configUpdated).toBe(false);
    expect(result.configSnippet).toContain("versions.archived");
    expect(result.configSnippet).toContain('{ id: "v2.0" },');
  });

  it("turns versioning on with the first cut", async () => {
    const root = await makeProject({
      "blume.config.ts": 'export default {\n  title: "Docs",\n};\n',
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const result = await cutVersion(root, "v1.0");
    expect(result.configUpdated).toBe(true);
    expect(result.versionsAdded).toBe(true);
    expect(result.configSnippet).toBeNull();
    expect(await readFile(join(root, "blume.config.ts"), "utf-8")).toBe(
      'export default {\n  versions: {\n    archived: [{ id: "v1.0" }],\n    current: { label: "Latest" },\n  },\n  title: "Docs",\n};\n'
    );
    // The registered snapshot routes as v1.0, so a scan no longer serves it as
    // current content. The scan reads a copy at a fresh path: Bun caches an
    // imported config by path, so rescanning `root` in this process could
    // see the config as it was before the cut (it does on Windows).
    const copy = await makeProject({
      "blume.config.ts": await readFile(join(root, "blume.config.ts"), "utf-8"),
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
      "docs/v1.0/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const project = await scanProject(copy);
    expect(project.config.versions?.archived.map((v) => v.id)).toEqual([
      "v1.0",
    ]);
  });

  it("prints a full snippet when the config resists a first-cut edit", async () => {
    const root = await makeProject({
      "blume.config.ts": "const config = {};\nexport default config;\n",
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    const result = await cutVersion(root, "v1.0");
    expect(result.configUpdated).toBe(false);
    expect(result.versionsAdded).toBe(false);
    expect(result.configSnippet).toContain("versions: {");
    expect(result.configSnippet).toContain('{ id: "v1.0" }');
    expect(result.configSnippet).toContain('current: { label: "Latest" }');
  });

  it("leaves links to pages outside the copied tree untouched", async () => {
    const root = await makeProject({
      // Spec-rendered reference pages carry no sourcePath and are not copied
      // into the snapshot, so links to them must keep pointing at the live
      // routes rather than a 404 inside the frozen tree.
      "blume.config.ts": `export default {
  reference: [{ kind: "openapi", options: { route: "/api", spec: "./openapi.yaml" }, requiredSecrets: [], runtimeDeps: [] }],
  versions: { archived: [], current: { label: "v2.0" } },
};
`,
      "docs/guides/x.mdx": "---\ntitle: X\n---\n# X\n",
      "docs/index.mdx":
        "---\ntitle: Home\n---\nSee [guide](/guides/x) and [API](/api).\n",
      "openapi.yaml": `openapi: 3.1.0
info:
  title: T
  version: "1.0"
paths:
  /auth:
    get:
      operationId: getAuth
      summary: Get auth
      responses:
        "200":
          description: OK
`,
    });
    await cutVersion(root, "v1.0");
    const index = await readFile(join(root, "docs/v1.0/index.mdx"), "utf-8");
    expect(index).toContain("(/v1.0/guides/x)");
    expect(index).toContain("(/api)");
  });

  it("never nests an unregistered version-shaped snapshot in a new cut", async () => {
    const root = await makeProject({
      // A config the first cut can't edit leaves v1.0 unregistered (the CLI
      // prints the snippet), so only the shape check can keep it out of v2.0.
      "blume.config.ts": "const config = {};\nexport default config;\n",
      "docs/guides/x.mdx": "---\ntitle: X\n---\n# X\n",
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
    });
    await cutVersion(root, "v1.0");
    await cutVersion(root, "v2.0");
    expect(existsSync(join(root, "docs/v2.0/index.mdx"))).toBe(true);
    expect(existsSync(join(root, "docs/v2.0/guides/x.mdx"))).toBe(true);
    expect(existsSync(join(root, "docs/v2.0/v1.0"))).toBe(false);
  });

  it("rejects an invalid id, a registered id, and an existing directory", async () => {
    const root = await makeProject({
      "blume.config.ts": VERSIONED_CONFIG,
      "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n",
      "docs/v1.0/index.mdx": "---\ntitle: Old\n---\n# Old\n",
    });

    await expect(cutVersion(root, "1.0")).rejects.toThrow(CutError);
    await expect(cutVersion(root, "v1.0")).rejects.toThrow(
      "already registered"
    );

    await mkdir(join(root, "docs/v3.0"), { recursive: true });
    await expect(cutVersion(root, "v3.0")).rejects.toThrow("--force");
    // --force replaces the stale directory.
    const forced = await cutVersion(root, "v3.0", { force: true });
    expect(forced.copied).toBeGreaterThan(0);
  });

  it("refuses to cut when the project has error diagnostics", async () => {
    const root = await makeProject({
      "blume.config.ts": VERSIONED_CONFIG,
      // Two files resolving to one route is an error diagnostic.
      "docs/x.md": "---\ntitle: A\n---\n# A\n",
      "docs/x.mdx": "---\ntitle: B\n---\n# B\n",
    });
    await expect(cutVersion(root, "v2.0")).rejects.toThrow("error diagnostic");
  });
});
