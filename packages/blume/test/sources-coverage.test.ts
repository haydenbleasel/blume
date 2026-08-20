import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { join } from "pathe";

import { BlumeError } from "../src/core/diagnostics.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { materializeAssets } from "../src/core/sources/assets.ts";
import {
  entriesDigest,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "../src/core/sources/cache.ts";
import { mdxRemoteSource } from "../src/core/sources/mdx-remote.ts";
import { portableTextToMarkdown } from "../src/core/sources/portable-text.ts";
import { readEntryText } from "../src/core/sources/read.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "../src/core/sources/types.ts";
import type { PageRecord } from "../src/core/types.ts";

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "blume-sources-")));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
});

const ctxFor = (cacheDir: string): SourceContext => ({
  cacheDir,
  mode: "build",
  projectRoot: cacheDir,
});

const entry = (ref: string, text: string): SourceEntry => ({
  body: { format: "md", text },
  data: {},
  ref,
});

/** The GitHub tree-listing payload the mocked tree API serves. */
interface TreeListing {
  tree: { path: string; type: string }[];
}

const okText = (text: string): Response => new Response(text);
const okJson = (data: TreeListing): Response => Response.json(data);
const notOk = (status: number): Response => new Response(null, { status });

type FetchHandler = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

// SAFETY: the source adapters call fetchImpl as a plain function; the
// preconnect helper Bun attaches to the real fetch is never accessed.
const asFetch = (handler: FetchHandler): typeof fetch =>
  handler as typeof fetch;

/**
 * Whether a mocked request is the repo tree listing (rather than a raw file
 * fetch from `raw.githubusercontent.com`). Compares the host, not a substring:
 * `api.github.com` can appear anywhere in a URL an attacker controls, so the
 * substring form is the wrong shape to teach here even in a fixture.
 */
const isTreeApi = (url: string): boolean =>
  URL.parse(url)?.hostname === "api.github.com";

describe("cache: entriesDigest", () => {
  it("is stable per content and sensitive to the entry set", () => {
    const hashed: SourceEntry = {
      body: { format: "md", text: "a" },
      data: {},
      hash: "h1",
      ref: "a.md",
    };
    // No `hash` → falls back to hashing the body text.
    const unhashed: SourceEntry = {
      body: { format: "md", text: "b" },
      data: {},
      ref: "b.md",
    };
    const entries = [hashed, unhashed];
    const digest = entriesDigest(entries);
    expect(digest).toBe(entriesDigest(entries));
    expect(digest).not.toBe(entriesDigest([hashed]));
  });
});

describe("cache: pollingWatch", () => {
  it("fires onChange when the digest changes and ignores fetch failures", async () => {
    let call = 0;
    const load = (): Promise<SourceLoadResult> => {
      call += 1;
      if (call === 2) {
        // A transient failure must not break polling.
        return Promise.reject(new Error("transient"));
      }
      return Promise.resolve({
        diagnostics: [],
        entries: [entry("a.md", `v${call}`)],
      });
    };
    let changes = 0;
    const stop = pollingWatch(
      load,
      0.01
    )(() => {
      changes += 1;
    });
    await sleep(120);
    stop();
    expect(changes).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(2);
  });
});

describe("cache: snapshotCache", () => {
  it("reads an empty array when the file is missing", async () => {
    const cache = snapshotCache(join(await tempDir(), "absent"));
    expect(await cache.read()).toEqual([]);
  });

  it("writes entries and reads them back", async () => {
    const cache = snapshotCache(join(await tempDir(), "cache"));
    await cache.write([entry("x.md", "x")]);
    const read = await cache.read();
    expect(read[0]?.ref).toBe("x.md");
  });

  it("swallows write failures (the cache is best-effort)", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "blocker");
    // A file where the cache dir should be makes `mkdir` fail.
    await writeFile(blocker, "x");
    const cache = snapshotCache(blocker);
    await cache.write([entry("x.md", "x")]);
    expect(await cache.read()).toEqual([]);
  });
});

describe("cache: loadWithCache", () => {
  it("serves the snapshot without fetching when refresh is false", async () => {
    const cache = snapshotCache(join(await tempDir(), "cache"));
    await cache.write([entry("c.md", "cached")]);
    let fetched = false;
    const result = await loadWithCache(
      "src",
      cache,
      () => {
        fetched = true;
        return Promise.resolve([]);
      },
      false
    );
    expect(fetched).toBe(false);
    expect(result.entries[0]?.ref).toBe("c.md");
  });

  it("fetches when refresh is false but the cache is empty", async () => {
    const cache = snapshotCache(join(await tempDir(), "empty"));
    const result = await loadWithCache(
      "src",
      cache,
      () => Promise.resolve([entry("fresh.md", "fresh")]),
      false
    );
    expect(result.entries[0]?.ref).toBe("fresh.md");
  });

  it("throws BLUME_SOURCE_FETCH_FAILED when fetch fails and no cache exists", async () => {
    const cache = snapshotCache(join(await tempDir(), "empty"));
    let thrown: unknown;
    try {
      await loadWithCache("src", cache, () =>
        Promise.reject(new Error("boom"))
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BlumeError);
    // SAFETY: the toBeInstanceOf assertion above proves thrown is a BlumeError.
    expect((thrown as BlumeError).diagnostic.code).toBe(
      "BLUME_SOURCE_FETCH_FAILED"
    );
  });
});

describe("mdxRemoteSource", () => {
  it("fetches an explicit file list and reads back from snapshot + cache", async () => {
    const fetchImpl = asFetch((input) => {
      const url = String(input);
      if (url.endsWith("guide.md")) {
        return Promise.resolve(okText("---\ntitle: Guide\n---\n# Guide\n"));
      }
      if (url.endsWith("api.mdx")) {
        return Promise.resolve(okText("# API\n"));
      }
      return Promise.resolve(notOk(404));
    });
    const source = mdxRemoteSource(
      {
        fetchImpl,
        // `a?c` and `x{y` (unterminated brace) exercise extra glob branches;
        // neither matches, so the final pattern decides inclusion.
        files: ["guide.md", "api.mdx", "ignored.txt"],
        include: ["a?c", "x{y", "**/*.{md,mdx}"],
        name: "remote",
        pollInterval: 30,
        url: "https://example.com/docs/",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries.map((e) => e.ref).toSorted()).toEqual([
      "api.mdx",
      "guide.md",
    ]);
    expect(entries.find((e) => e.ref === "guide.md")?.data.title).toBe("Guide");
    expect(entries.find((e) => e.ref === "guide.md")?.body.format).toBe("md");
    expect(entries.find((e) => e.ref === "api.mdx")?.body.format).toBe("mdx");
    expect(source.watch).toBeInstanceOf(Function);
    expect(await source.read?.("guide.md")).toContain("title: Guide");
    expect(await source.read?.("missing.md")).toBe("");
  });

  it("treats **/ as whole segments, not a substring wildcard", async () => {
    const fetchImpl = asFetch((input) =>
      Promise.resolve(
        String(input).endsWith(".md") ? okText("# Doc\n") : notOk(404)
      )
    );
    const source = mdxRemoteSource(
      {
        fetchImpl,
        // `**/guide.md` must match `guide.md` and `sub/guide.md`, but not
        // `subguide.md` — `**` may not bleed into a segment. A trailing bare
        // `**` (`misc/**`) still spans anything beneath.
        files: ["guide.md", "sub/guide.md", "subguide.md", "misc/deep.md"],
        include: ["**/guide.md", "misc/**"],
        name: "remote",
        url: "https://example.com/docs/",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries.map((e) => e.ref).toSorted()).toEqual([
      "guide.md",
      "misc/deep.md",
      "sub/guide.md",
    ]);
  });

  it("watch polls fresh past the dev cache and fires on changed remote files", async () => {
    let calls = 0;
    const fetchImpl = asFetch((input) => {
      if (String(input).endsWith("a.md")) {
        calls += 1;
        return Promise.resolve(okText(`# Doc v${calls}\n`));
      }
      return Promise.resolve(notOk(404));
    });
    const source = mdxRemoteSource(
      {
        fetchImpl,
        files: ["a.md"],
        include: ["**/*.md"],
        name: "remote",
        pollInterval: 0.01,
        url: "https://example.com/docs/",
      },
      { ...ctxFor(await tempDir()), refresh: false }
    );
    await source.load();

    let changes = 0;
    const stop = source.watch?.(() => {
      changes += 1;
    });
    await sleep(80);
    stop?.();
    expect(changes).toBeGreaterThanOrEqual(1);
  });

  it("enumerates a github subtree, skipping trees and non-matching blobs", async () => {
    const tree = {
      tree: [
        { path: "docs/guide.md", type: "blob" },
        { path: "docs/nested/api.mdx", type: "blob" },
        { path: "docs/skip.txt", type: "blob" },
        { path: "docs/sub", type: "tree" },
        { path: "other/x.md", type: "blob" },
      ],
    };
    const fetchImpl = asFetch((input) => {
      const url = String(input);
      if (isTreeApi(url)) {
        return Promise.resolve(okJson(tree));
      }
      if (url.endsWith("guide.md")) {
        return Promise.resolve(okText("# Guide\n"));
      }
      if (url.endsWith("api.mdx")) {
        return Promise.resolve(okText("# Api\n"));
      }
      return Promise.resolve(notOk(404));
    });
    const source = mdxRemoteSource(
      {
        fetchImpl,
        github: { owner: "o", path: "docs", ref: "main", repo: "r" },
        include: ["**/*.{md,mdx}"],
        name: "remote",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries.map((e) => e.ref).toSorted()).toEqual([
      "guide.md",
      "nested/api.mdx",
    ]);
    expect(entries.find((e) => e.ref === "guide.md")?.editUrl).toContain(
      "github.com/o/r/edit/main/docs/guide.md"
    );
  });

  it("throws when the github tree request fails", async () => {
    const fetchImpl = asFetch(() => Promise.resolve(notOk(403)));
    const source = mdxRemoteSource(
      {
        fetchImpl,
        github: { owner: "o", path: "", ref: "main", repo: "r" },
        include: ["**/*.md"],
        name: "remote",
      },
      ctxFor(await tempDir())
    );
    await expect(source.load()).rejects.toThrow();
  });

  it("throws when a file fetch fails and no cache exists", async () => {
    const fetchImpl = asFetch(() => Promise.resolve(notOk(404)));
    const source = mdxRemoteSource(
      {
        fetchImpl,
        files: ["a.md"],
        include: ["**/*.md"],
        name: "remote",
        url: "https://example.com/docs",
      },
      ctxFor(await tempDir())
    );
    await expect(source.load()).rejects.toThrow();
  });

  it("rejects a source missing both github and url/files", async () => {
    const source = mdxRemoteSource(
      { include: ["**/*.md"], name: "remote" },
      ctxFor(await tempDir())
    );
    await expect(source.load()).rejects.toThrow();
  });
});

describe("portableTextToMarkdown: plain-text escaping", () => {
  it("renders literal Markdown syntax in prose spans as itself", () => {
    // Portable Text spans are plain text: formatting comes from marks, so a
    // literal asterisk or bracket typed in the CMS must not open emphasis or
    // a link label — and `<` must not smuggle raw HTML into the page.
    const md = portableTextToMarkdown([
      {
        _type: "block",
        children: [
          {
            _type: "span",
            marks: [],
            text: "5 * 3 and snake_case and [not a link] <em>plain</em>",
          },
        ],
        style: "normal",
      },
    ]);
    expect(md).toContain(String.raw`5 \* 3`);
    expect(md).toContain(String.raw`snake\_case`);
    expect(md).toContain(String.raw`\[not a link\]`);
    expect(md).toContain(String.raw`\<em>plain\</em>`);
  });

  it("keeps code-marked spans verbatim", () => {
    const md = portableTextToMarkdown([
      {
        _type: "block",
        children: [{ _type: "span", marks: ["code"], text: "a * b" }],
        style: "normal",
      },
    ]);
    expect(md).toContain("`a * b`");
  });
});

describe("portableTextToMarkdown: extra marks", () => {
  it("renders code and strike-through decorators", () => {
    const md = portableTextToMarkdown([
      {
        _type: "block",
        children: [
          { _type: "span", marks: ["code"], text: "snippet" },
          { _type: "span", marks: [], text: " and " },
          { _type: "span", marks: ["strike-through"], text: "gone" },
        ],
        style: "normal",
      },
    ]);
    expect(md).toContain("`snippet`");
    expect(md).toContain("~~gone~~");
  });
});

describe("materializeAssets: failure path", () => {
  it("records a diagnostic and keeps the original url when a download fails", async () => {
    const fetchImpl = asFetch(() => Promise.resolve(notOk(503)));
    const dir = await tempDir();
    const { diagnostics, markdown } = await materializeAssets(
      "![pic](https://cdn.example.com/a.png)",
      { assetsBaseUrl: "/assets", assetsDir: join(dir, "assets"), fetchImpl }
    );
    expect(diagnostics[0]?.code).toBe("BLUME_ASSET_FETCH_FAILED");
    expect(markdown).toContain("https://cdn.example.com/a.png");
  });
});

/** The rewritten local asset filename in a materialized markdown body. */
const localAssetFile = (md: string): string | undefined =>
  /\(\/assets\/(?<file>[^)]+)\)/u.exec(md)?.groups?.file;

describe("materializeAssets: signed-url stability", () => {
  it("addresses an asset by its query-less url, so re-signed urls reuse one file", async () => {
    const fetchImpl = asFetch(() =>
      Promise.resolve(new Response(new ArrayBuffer(4)))
    );
    const dir = await tempDir();
    const materialize = (signature: string) =>
      materializeAssets(
        `![pic](https://s3.example.com/img.png?X-Amz-Signature=${signature})`,
        { assetsBaseUrl: "/assets", assetsDir: join(dir, "assets"), fetchImpl }
      );
    // Notion-style pre-signed URLs change their query on every API call; the
    // local filename must not, or every dev poll re-dirties the content and
    // duplicate files pile up under the assets dir.
    const first = await materialize("aaa");
    const second = await materialize("bbb");
    expect(localAssetFile(first.markdown)).toBeDefined();
    expect(localAssetFile(first.markdown)).toBe(
      localAssetFile(second.markdown)
    );
    expect(localAssetFile(first.markdown)).toEndWith(".png");
  });
});

describe("materializeAssets: fenced code", () => {
  it("never downloads or rewrites an image url inside a code fence", async () => {
    const fetched: string[] = [];
    const fetchImpl = asFetch((input) => {
      fetched.push(String(input));
      return Promise.resolve(new Response(new ArrayBuffer(4)));
    });
    const dir = await tempDir();
    const body = [
      "![real](https://cdn.example.com/a.png)",
      "",
      "```md",
      "![sample](https://cdn.example.com/b.png)",
      "```",
      "",
    ].join("\n");
    const { markdown } = await materializeAssets(body, {
      assetsBaseUrl: "/assets",
      assetsDir: join(dir, "assets"),
      fetchImpl,
    });
    // Only the prose image is materialized; the code sample stays verbatim.
    expect(fetched).toStrictEqual(["https://cdn.example.com/a.png"]);
    expect(markdown).toContain("![real](/assets/");
    expect(markdown).toContain("![sample](https://cdn.example.com/b.png)");
  });
});

// SAFETY: readEntryText reads only body, source, and sourcePath from the page
// record, so a partial fixture stands in for a full PageRecord.
const pageOf = (page: Partial<PageRecord>): PageRecord => page as PageRecord;

describe("readEntryText", () => {
  it("returns the staged body text when present", async () => {
    const text = await readEntryText(
      {},
      pageOf({ body: { format: "md", text: "staged" } })
    );
    expect(text).toBe("staged");
  });

  it("reads from the owning source for unstaged entries", async () => {
    const source: ContentSource = {
      load: () => Promise.resolve({ diagnostics: [], entries: [] }),
      name: "s",
      read: (ref: string) => Promise.resolve(`read:${ref}`),
      staged: true,
    };
    const text = await readEntryText(
      { sources: [source] },
      pageOf({ source: { name: "s", ref: "a.md" } })
    );
    expect(text).toBe("read:a.md");
  });

  it("falls back to the filesystem path", async () => {
    const dir = await tempDir();
    const file = join(dir, "x.md");
    await writeFile(file, "from disk");
    const text = await readEntryText(
      {},
      pageOf({ source: { name: "fs", ref: "x.md" }, sourcePath: file })
    );
    expect(text).toBe("from disk");
  });

  it("returns an empty string when nothing resolves", async () => {
    const text = await readEntryText(
      {},
      pageOf({ source: { name: "x", ref: "y" } })
    );
    expect(text).toBe("");
  });
});

describe("scanProject: git last-modified branch", () => {
  it("resolves git commit dates for filesystem pages", async () => {
    const root = await tempDir();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "blume.config.ts"),
      "export default { lastModified: true };\n"
    );
    await writeFile(join(root, "docs", "index.md"), "# Home\n");
    // Strip the repo-locating GIT_* variables a parent git process exports to
    // its hooks: under the pre-commit hook in a linked worktree, an inherited
    // absolute GIT_DIR overrides `-C` discovery and the fixture's
    // `add -A`/`commit` would run against the real repository's branch.
    const gitLocationVars = new Set([
      "GIT_COMMON_DIR",
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_PREFIX",
      "GIT_WORK_TREE",
    ]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !gitLocationVars.has(key))
    );
    const git = (args: string[]): void => {
      // Test fixture drives a real git repo; `git` is expected on PATH in CI/dev.
      // oxlint-disable-next-line sonarjs/no-os-command-from-path
      execFileSync("git", ["-C", root, ...args], { env, stdio: "ignore" });
    };
    git(["init"]);
    git(["config", "user.email", "test@blume.dev"]);
    git(["config", "user.name", "Blume Test"]);
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "init"]);

    const project = await scanProject(root, { mode: "build" });
    expect(project.manifest.routes[0]?.lastModified).toMatch(
      /^\d{4}-\d{2}-\d{2}T/u
    );
  });
});
