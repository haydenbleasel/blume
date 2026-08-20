import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { dirname, join, relative } from "pathe";
import { z } from "zod";

import { generateRuntime } from "../src/astro/generate.ts";
import { contentConfigTemplate } from "../src/astro/templates.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { FrontmatterExtend } from "../src/core/schema.ts";
import { entriesDigest } from "../src/core/sources/cache.ts";
import { filesystemSource } from "../src/core/sources/filesystem.ts";
import { mdxRemoteSource } from "../src/core/sources/mdx-remote.ts";
import { normalizeEntry, slugifyPath } from "../src/core/sources/normalize.ts";
import type {
  NormalizeContext,
  SourceContext,
  SourceEntry,
} from "../src/core/sources/types.ts";
import type { NavNode, ProjectContext } from "../src/core/types.ts";
import { eject } from "../src/registry/eject.ts";

/** Recursively find the first sidebar group with a given label. */
const findGroup = (nodes: NavNode[], label: string): NavNode | null => {
  for (const node of nodes) {
    if (node.kind === "group") {
      if (node.label === label) {
        return node;
      }
      const nested = findGroup(node.children, label);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
};

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

/** Canned responses for the injected fetch. */
const ok = (text: string): Response => new Response(text);

/** The GitHub tree-listing shape the github-mode fixtures answer with. */
interface TreeListing {
  tree: { path: string; type: string }[];
  truncated?: boolean;
}

const okJson = (value: TreeListing): Response => Response.json(value);
const notFound = (): Response => new Response("", { status: 404 });

// SAFETY: the sources under test invoke `fetchImpl` only as a plain
// `(url, init)` call with string URLs; Bun's extra `fetch.preconnect` is
// never touched.
const asFetch = (
  impl: (input: string | URL, init?: RequestInit) => Promise<Response>
): typeof fetch => impl as typeof fetch;

/**
 * Whether a mocked request is the repo tree listing (rather than a raw file
 * fetch from `raw.githubusercontent.com`). Compares the host, not a substring:
 * `api.github.com` can appear anywhere in a URL an attacker controls, so the
 * substring form is the wrong shape to teach here even in a fixture.
 */
const isTreeApi = (url: string): boolean =>
  URL.parse(url)?.hostname === "api.github.com";

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

  it("skips never-content dirs (node_modules, dist, .blume, …) even at a `.`-rooted scan", async () => {
    const root = await makeProject({
      ".blume/src/pages/gen.md": "# generated\n",
      ".vercel/output/cached.md": "# cached\n",
      "dist/bundle.md": "# built\n",
      "getting-started.md": "# Start\n",
      "guide/setup.md": "# Setup\n",
      "node_modules/some-dep/readme.md": "# dep\n",
    });
    // The migrated-monorepo shape: docs live at the app root beside node_modules
    // and build output, with `exclude` overridden away from its defaults.
    const source = filesystemSource({
      exclude: [],
      include: ["**/*.{md,mdx}"],
      name: "filesystem",
      projectRoot: root,
      root: ".",
    });

    const { entries } = await source.load();
    expect(entries.map((entry) => entry.ref).toSorted()).toStrictEqual([
      "getting-started.md",
      "guide/setup.md",
    ]);
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

const routeOf = (data: SourceEntry["data"], prefix?: string) =>
  normalizeEntry(
    { body: { format: "md", text: "# X\n" }, data, ref: "page.md" },
    {
      defaultType: "doc",
      source: { name: "s", prefix, staged: false },
    }
  ).pages[0];

const entryRouteOf = (entry: Partial<SourceEntry>) =>
  normalizeEntry(
    {
      body: { format: "md", text: "# X\n" },
      data: {},
      ref: "abc123.md",
      ...entry,
    },
    { defaultType: "doc", source: { name: "s", staged: false } }
  ).pages[0];

describe(slugifyPath, () => {
  it("keeps path separators while slugging each segment", () => {
    // `slugify` alone deletes `/` with the rest of the punctuation, which
    // would mash `guides/getting-started` into `guidesgetting-started`.
    expect(slugifyPath("guides/getting-started")).toBe(
      "guides/getting-started"
    );
    expect(slugifyPath("Guides/Getting Started!")).toBe(
      "guides/getting-started"
    );
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

  it("strips characters that break URL construction from route segments", () => {
    // A `:` ahead of the first `/` turns the route into a URL scheme
    // (`Guide: Architecture.md` → `guide:`) and crashes Astro's prerender
    // write; control characters are silently dropped by the URL parser,
    // desyncing the route from its output path. Both are legal filenames.
    expect(entryRouteOf({ ref: "Guide: Architecture.md" })?.route).toBe(
      "/Guide Architecture"
    );
    expect(entryRouteOf({ ref: "Guide\nArch.md" })?.route).toBe("/GuideArch");
    // A segment that was nothing but stripped characters cannot survive as an
    // empty route piece; the remaining segments still form the route.
    expect(entryRouteOf({ ref: ":/setup.md" })?.route).toBe("/setup");
  });

  it("normalizes slashed slugs and prefixes into clean routes", () => {
    const page = routeOf;
    // A leading-slash slug (Mintlify/CMS habit) must not produce `//route`.
    expect(page({ slug: "/getting-started" })?.route).toBe("/getting-started");
    // A trailing slash must not produce `/route/`.
    expect(page({ slug: "guides/" })?.route).toBe("/guides");
    // Dotted slug segments survive (the appended extension absorbs extname).
    expect(page({ slug: "releases/v1.2" })?.route).toBe("/releases/v1.2");
    // Slashed prefixes normalize the same way.
    expect(page({}, "/changelog")?.route).toBe("/changelog/page");
    expect(page({}, "changelog/")?.route).toBe("/changelog/page");
  });

  it("drops empty ref segments instead of emitting a malformed route", () => {
    // A doubled separator (or leading/trailing slash) in a ref yields an empty
    // path part; keeping it would produce `//` in the route.
    expect(entryRouteOf({ ref: "guide//setup.md" })?.route).toBe(
      "/guide/setup"
    );
  });

  it("honors an adapter-supplied entry.slug, with frontmatter slug winning", () => {
    // The typed SPI documents slug as "logical route input; defaults to ref".
    expect(entryRouteOf({ slug: "custom/path" })?.route).toBe("/custom/path");
    expect(entryRouteOf({})?.route).toBe("/abc123");
    expect(
      entryRouteOf({ data: { slug: "from-frontmatter" }, slug: "from-adapter" })
        ?.route
    ).toBe("/from-frontmatter");
  });

  it("falls back to the configured defaultType when frontmatter has no type", () => {
    const { pages } = normalizeEntry(fsEntry, {
      defaultType: "guide",
      source: { name: "filesystem", staged: false },
    });
    expect(pages[0]?.contentType).toBe("guide");

    const typed = normalizeEntry(
      { ...fsEntry, data: { type: "blog" } },
      { defaultType: "guide", source: { name: "filesystem", staged: false } }
    );
    expect(typed.pages[0]?.contentType).toBe("blog");
  });

  it("treats top-level hidden/noindex frontmatter as the nested shorthands", () => {
    const { pages } = normalizeEntry(
      { ...fsEntry, data: { hidden: true, noindex: true } },
      { defaultType: "doc", source: { name: "filesystem", staged: false } }
    );
    expect(pages[0]?.meta.sidebar.hidden).toBe(true);
    expect(pages[0]?.meta.seo.noindex).toBe(true);
  });

  it("offsets link lines by the stripped frontmatter block's height", async () => {
    // The link sits on line 6 of the raw file; the offset (raw minus stripped
    // body line counts) must surface that line, not the body-relative line 2.
    const root = await makeProject({
      "docs/a.md": "---\ntitle: A\ndescription: D\n---\n\n[missing](/nope)\n",
    });
    const source = filesystemSource({
      exclude: [],
      include: ["**/*.md"],
      name: "filesystem",
      projectRoot: root,
      root: "docs",
    });
    const { entries } = await source.load();
    // SAFETY: the fixture above writes exactly one file under docs/, so load()
    // yields exactly one entry.
    const entry = entries[0] as SourceEntry;
    const { pages } = normalizeEntry(entry, {
      defaultType: "doc",
      source: { name: "filesystem", staged: false },
    });
    expect(pages[0]?.links).toStrictEqual([
      { column: 11, line: 6, target: "/nope" },
    ]);
  });

  it("leaves link lines unshifted when an entry carries no raw text", () => {
    // A body-only entry (no frontmatter was stripped) keeps body-relative lines.
    const { pages } = normalizeEntry(
      {
        body: { format: "md", text: "# X\n\n[a](/a)\n" },
        data: {},
        ref: "x.md",
      },
      { defaultType: "doc", source: { name: "s", staged: false } }
    );
    expect(pages[0]?.links).toStrictEqual([
      { column: 5, line: 3, target: "/a" },
    ]);
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

  it("rejects an invalid sidebar.display naming the file and key", () => {
    const { pages, diagnostics } = normalizeEntry(
      {
        body: { format: "md", text: "# SDKs\n" },
        data: { sidebar: { display: "pages" }, title: "SDKs" },
        ref: "sdks/index.md",
        sourcePath: "/abs/sdks/index.md",
      },
      { defaultType: "doc", source: { name: "filesystem", staged: false } }
    );
    // The invalid page is dropped; strict builds fail on the diagnostic and
    // `--no-strict` surfaces it in the dropped-page count.
    expect(pages).toHaveLength(0);
    expect(diagnostics[0]?.code).toBe("BLUME_FRONTMATTER_INVALID");
    expect(diagnostics[0]?.file).toBe("/abs/sdks/index.md");
    expect(diagnostics[0]?.schemaPath).toBe("sidebar.display");
  });
});

const entryWith = (data: SourceEntry["data"]): SourceEntry => ({
  body: { format: "md", text: "# Page\n" },
  data,
  ref: "page.md",
});

const ctxWith = (extend: FrontmatterExtend): NormalizeContext => ({
  defaultType: "doc",
  frontmatterExtend: extend,
  source: { name: "filesystem", staged: false },
});

const typedCtx = (
  typeFrontmatter: NonNullable<NormalizeContext["typeFrontmatter"]>,
  extend?: FrontmatterExtend
): NormalizeContext => ({
  defaultType: "doc",
  frontmatterExtend: extend,
  source: { name: "filesystem", staged: false },
  typeFrontmatter,
});

describe("normalizeEntry with frontmatter.extend", () => {
  it("rejects unknown keys when no extension is configured", () => {
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ owner: "@sam", title: "Page" }),
      { defaultType: "doc", source: { name: "filesystem", staged: false } }
    );
    expect(pages).toHaveLength(0);
    expect(diagnostics[0]?.code).toBe("BLUME_FRONTMATTER_INVALID");
  });

  it("accepts declared keys and preserves their validated values", () => {
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ owner: "@sam", reviewed: "2026-01-01", title: "Page" }),
      ctxWith({
        owner: z.string(),
        // Transforms apply: `custom` holds the schema output, not the input.
        reviewed: z.string().transform((value) => `on ${value}`),
      })
    );
    expect(diagnostics).toStrictEqual([]);
    expect(pages[0]?.custom).toStrictEqual({
      owner: "@sam",
      reviewed: "on 2026-01-01",
    });
    // Built-in keys still parse through the strict page schema.
    expect(pages[0]?.meta.title).toBe("Page");
  });

  it("reports custom-key failures under the key's path", () => {
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ owner: 5 }),
      ctxWith({ owner: z.string() })
    );
    expect(pages).toHaveLength(0);
    expect(diagnostics[0]?.code).toBe("BLUME_FRONTMATTER_INVALID");
    expect(diagnostics[0]?.schemaPath).toBe("owner");
  });

  it("enforces a required key on every page; optional keys relax it", () => {
    // Absent keys are validated too, so `owner: z.string()` is site-wide.
    const required = normalizeEntry(
      entryWith({}),
      ctxWith({ owner: z.string() })
    );
    expect(required.pages).toHaveLength(0);
    expect(required.diagnostics[0]?.schemaPath).toBe("owner");

    const optional = normalizeEntry(
      entryWith({}),
      ctxWith({ owner: z.string().optional() })
    );
    expect(optional.diagnostics).toStrictEqual([]);
    expect(optional.pages[0]?.custom).toBeUndefined();
  });

  it("keeps strict typo-catching for keys outside the extension", () => {
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ onwer: "@sam" }),
      ctxWith({ owner: z.string().optional() })
    );
    expect(pages).toHaveLength(0);
    expect(diagnostics[0]?.code).toBe("BLUME_FRONTMATTER_INVALID");
    expect(diagnostics[0]?.message).toContain("onwer");
  });

  it("lowers standard-schema issue paths, including { key } segments", () => {
    // The spec allows path segments as raw PropertyKeys or `{ key }` objects;
    // both must join into the diagnostic's dotted schemaPath.
    const nested: FrontmatterExtend[string] = {
      "~standard": {
        validate: () => ({
          issues: [
            { message: "bad", path: [{ key: "meta" }, Symbol("sym"), 0] },
          ],
        }),
        vendor: "test",
        version: 1,
      },
    };
    const { diagnostics } = normalizeEntry(
      entryWith({ owner: {} }),
      ctxWith({ owner: nested })
    );
    expect(diagnostics[0]?.schemaPath).toBe("owner.meta.Symbol(sym).0");
    expect(diagnostics[0]?.message).toContain("bad");
  });

  it("rejects async schemas with a diagnostic instead of hanging", () => {
    const asyncSchema: FrontmatterExtend[string] = {
      "~standard": {
        validate: (value) => Promise.resolve({ value }),
        vendor: "test",
        version: 1,
      },
    };
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ owner: "@sam" }),
      ctxWith({ owner: asyncSchema })
    );
    expect(pages).toHaveLength(0);
    expect(diagnostics[0]?.message).toContain("Async schemas");
  });
});

describe("normalizeEntry with content.types frontmatter", () => {
  it("enforces a per-type key only on pages of that type", () => {
    const ctx = typedCtx({ rfc: { status: z.string() } });

    const rfc = normalizeEntry(entryWith({ title: "RFC 1", type: "rfc" }), ctx);
    expect(rfc.pages).toHaveLength(0);
    expect(rfc.diagnostics[0]?.code).toBe("BLUME_FRONTMATTER_INVALID");
    expect(rfc.diagnostics[0]?.schemaPath).toBe("status");

    const doc = normalizeEntry(entryWith({ title: "Guide" }), ctx);
    expect(doc.diagnostics).toStrictEqual([]);
    expect(doc.pages[0]?.custom).toBeUndefined();
  });

  it("preserves validated per-type values on the page's custom field", () => {
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ status: "enforced", title: "RFC 1", type: "rfc" }),
      typedCtx({ rfc: { status: z.string() } })
    );
    expect(diagnostics).toStrictEqual([]);
    expect(pages[0]?.contentType).toBe("rfc");
    expect(pages[0]?.custom).toStrictEqual({ status: "enforced" });
  });

  it("keeps a key declared for another type unknown", () => {
    // `status` exists only for `rfc`, so on a doc page it's still a typo-level
    // unknown key — per-type declarations don't loosen other types.
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ status: "enforced", title: "Guide" }),
      typedCtx({ rfc: { status: z.string() } })
    );
    expect(pages).toHaveLength(0);
    expect(diagnostics[0]?.code).toBe("BLUME_FRONTMATTER_INVALID");
    expect(diagnostics[0]?.message).toContain("status");
  });

  it("merges site-wide extend keys with the page type's keys", () => {
    const { pages, diagnostics } = normalizeEntry(
      entryWith({
        owner: "@sam",
        status: "draft",
        title: "RFC 1",
        type: "rfc",
      }),
      typedCtx({ rfc: { status: z.string() } }, { owner: z.string() })
    );
    expect(diagnostics).toStrictEqual([]);
    expect(pages[0]?.custom).toStrictEqual({
      owner: "@sam",
      status: "draft",
    });
  });

  it("applies the default type's declaration to pages that set no type", () => {
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ owner: "@sam", title: "Guide" }),
      typedCtx({ doc: { owner: z.string() } })
    );
    expect(diagnostics).toStrictEqual([]);
    expect(pages[0]?.contentType).toBe("doc");
    expect(pages[0]?.custom).toStrictEqual({ owner: "@sam" });
  });

  it("rejects a non-string type through the strict page schema", () => {
    // Type resolution falls back to `defaultType` for the carve-out, but the
    // strict parse still owns rejecting the malformed `type` itself.
    const { pages, diagnostics } = normalizeEntry(
      entryWith({ title: "Guide", type: 5 }),
      typedCtx({ rfc: { status: z.string() } })
    );
    expect(pages).toHaveLength(0);
    expect(diagnostics[0]?.code).toBe("BLUME_FRONTMATTER_INVALID");
  });
});

describe("mdxRemoteSource (files mode)", () => {
  const FILES = new Map([
    ["guide.md", "---\ntitle: Guide\n---\n# Guide\n"],
    ["intro.mdx", "---\ntitle: Intro\n---\n# Intro\n"],
    ["notes.txt", "ignored\n"],
  ]);

  const fetchOk = asFetch((input) => {
    const ref = input.toString().split("/").pop() ?? "";
    const file = FILES.get(ref);
    return Promise.resolve(file ? ok(file) : notFound());
  });

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

    const failing = asFetch(() => Promise.reject(new Error("network down")));
    const offline = mdxRemoteSource(
      { ...opts, fetchImpl: failing },
      ctxFor(cacheDir)
    );
    const { entries, diagnostics } = await offline.load();

    expect(entries).toHaveLength(2);
    expect(diagnostics.map((d) => d.code)).toContain("BLUME_SOURCE_OFFLINE");
  });

  it("surfaces a misconfiguration even when a cache snapshot exists", async () => {
    const cacheDir = join(await makeProject({}), ".cache");
    const opts = {
      files: ["intro.mdx", "guide.md"],
      include: ["**/*.{md,mdx}"],
      name: "sdk",
      url: "https://example.com/docs",
    };

    // Prime the cache so a fetch-time failure would fall back to it.
    await mdxRemoteSource(
      { ...opts, fetchImpl: fetchOk },
      ctxFor(cacheDir)
    ).load();

    // Dropping `url` misconfigures the source. Thrown from inside the cached
    // fetch it would be downgraded to a BLUME_SOURCE_OFFLINE warning serving
    // stale entries — it must stay a hard BLUME_SOURCE_MISCONFIGURED error.
    const misconfigured = mdxRemoteSource(
      { files: opts.files, include: opts.include, name: "sdk" },
      ctxFor(cacheDir)
    );
    await expect(misconfigured.load()).rejects.toMatchObject({
      diagnostic: { code: "BLUME_SOURCE_MISCONFIGURED" },
    });
  });

  it("only sends GITHUB_TOKEN to GitHub hosts, never a custom url base", async () => {
    const original = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "t0ken";
    try {
      const sent = new Map<string, string | undefined>();
      const spying = asFetch((input, init) => {
        sent.set(
          input.toString(),
          new Headers(init?.headers).get("authorization") ?? undefined
        );
        return Promise.resolve(ok("---\ntitle: X\n---\n# X\n"));
      });

      const load = (url: string, cacheDir: string) =>
        mdxRemoteSource(
          {
            fetchImpl: spying,
            files: ["intro.mdx"],
            include: ["**/*.mdx"],
            name: "sdk",
            url,
          },
          ctxFor(cacheDir)
        ).load();

      const root = await makeProject({});
      await load("https://example.com/docs", join(root, ".c1"));
      expect(sent.get("https://example.com/docs/intro.mdx")).toBeUndefined();

      await load(
        "https://raw.githubusercontent.com/o/r/main/docs",
        join(root, ".c2")
      );
      expect(
        sent.get("https://raw.githubusercontent.com/o/r/main/docs/intro.mdx")
      ).toBe("Bearer t0ken");

      // An unparsable base URL can't be host-checked, so no token is sent.
      await load("not-a-url", join(root, ".c3"));
      expect(sent.get("not-a-url/intro.mdx")).toBeUndefined();

      // Without a token in the environment, even GitHub hosts get no header.
      delete process.env.GITHUB_TOKEN;
      await load(
        "https://raw.githubusercontent.com/o/r/main/other",
        join(root, ".c4")
      );
      expect(
        sent.get("https://raw.githubusercontent.com/o/r/main/other/intro.mdx")
      ).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = original;
      }
    }
  });

  it("skips a single failed file and imports the rest with a warning", async () => {
    const cacheDir = join(await makeProject({}), ".cache");
    const source = mdxRemoteSource(
      {
        // `gone.mdx` isn't in FILES, so fetchOk 404s it.
        fetchImpl: fetchOk,
        files: ["intro.mdx", "gone.mdx", "guide.md"],
        include: ["**/*.{md,mdx}"],
        name: "sdk",
        url: "https://example.com/docs",
      },
      ctxFor(cacheDir)
    );

    const { entries, diagnostics } = await source.load();
    expect(entries.map((entry) => entry.ref).toSorted()).toStrictEqual([
      "guide.md",
      "intro.mdx",
    ]);
    expect(diagnostics.map((d) => d.code)).toContain(
      "BLUME_SOURCE_FETCH_FAILED"
    );
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
    const fetchImpl = asFetch((input) => {
      const url = input.toString();
      if (isTreeApi(url)) {
        return Promise.resolve(okJson(tree));
      }
      return Promise.resolve(
        ok(`---\ntitle: ${url.split("/").pop()}\n---\nbody\n`)
      );
    });

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

  it("warns when GitHub truncates the tree listing", async () => {
    const tree = {
      tree: [{ path: "docs/a.md", type: "blob" }],
      truncated: true,
    };
    const fetchImpl = asFetch((input) =>
      isTreeApi(input.toString())
        ? Promise.resolve(okJson(tree))
        : Promise.resolve(ok("---\ntitle: A\n---\nbody\n"))
    );

    const cacheDir = join(await makeProject({}), ".cache");
    const source = mdxRemoteSource(
      {
        fetchImpl,
        github: { owner: "acme", path: "docs", ref: "main", repo: "sdk" },
        include: ["**/*.{md,mdx}"],
        name: "sdk",
      },
      ctxFor(cacheDir)
    );

    const { diagnostics } = await source.load();
    expect(diagnostics.map((d) => d.code)).toContain("BLUME_SOURCE_TRUNCATED");
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

  it("applies folder meta and resolves entry ids for a prefixed source", async () => {
    const root = await withConfig(
      {
        "docs/guides/intro.mdx": "---\ntitle: Intro\n---\nIntro\n",
        "docs/guides/meta.ts":
          'export default { title: "Guides", order: 2 };\n',
        "docs/index.mdx": "---\ntitle: Home\n---\nHome\n",
        "docs/provider/biome.mdx": "---\ntitle: Biome\n---\nBiome\n",
        "docs/provider/meta.ts":
          'export default { title: "Providers", order: 1 };\n',
        "docs/setup.mdx": "---\ntitle: Setup\n---\nSetup\n",
      },
      `export default {
        content: {
          sources: [
            { type: "filesystem", root: "docs", prefix: "docs" },
          ],
        },
      };\n`
    );

    const project = await scanProject(root, { mode: "build" });

    // Every doc route is present and its entry id matches the id the `docs`
    // collection (rooted at the source) would generate — so getEntry resolves.
    const routes = new Map(
      project.manifest.routes.map((r) => [r.path, r] as const)
    );
    expect([...routes.keys()].toSorted()).toStrictEqual([
      "/docs",
      "/docs/guides/intro",
      "/docs/provider/biome",
      "/docs/setup",
    ]);
    expect(routes.get("/docs")?.entryId).toBe("index.mdx");
    expect(routes.get("/docs/provider/biome")?.entryId).toBe(
      "provider/biome.mdx"
    );

    // No entry-id mismatch: the single source roots the collection.
    expect(
      project.diagnostics.filter((d) => d.severity === "error")
    ).toStrictEqual([]);

    // The prefixed `meta.ts` applies its title (not the humanized folder name).
    // Humanized fallbacks would have been "Provider"/"Guides"; the meta title
    // renames the first, proving the prefixed lookup hit.
    const { sidebar } = project.graph.navigation;
    expect(findGroup(sidebar, "Providers")).not.toBeNull();
    expect(findGroup(sidebar, "Provider")).toBeNull();

    // ...and its order: Providers (order 1) sorts before Guides (order 2). Both
    // are siblings under the prefixed "Docs" section.
    const section = findGroup(sidebar, "Docs");
    const groupLabels =
      section?.kind === "group"
        ? section.children
            .filter((child) => child.kind === "group")
            .map((child) => child.label)
        : [];
    expect(groupLabels).toStrictEqual(["Providers", "Guides"]);

    // End to end: the generated `docs` collection roots at the source's own
    // root, so Astro's generated ids equal the manifest entry ids — getEntry
    // resolves (the dev 404 is gone) and a `provider/biome.mdx` file exists there.
    await generateRuntime(project);
    const contentConfig = await readFile(
      join(root, ".blume/src/content.config.ts"),
      "utf-8"
    );
    // The absolute collection base is emitted as a `file://` URL so Astro's
    // glob loader doesn't parse a Windows drive letter as a URL scheme.
    expect(contentConfig).toContain(
      `base: ${JSON.stringify(pathToFileURL(join(root, "docs")).href)}`
    );
    for (const route of project.manifest.routes) {
      const expected = relative(join(root, "docs"), route.sourcePath ?? "");
      expect(route.entryId).toBe(expected);
    }
  });

  it("flags an entry-id/collection-base mismatch as an error", async () => {
    const root = await withConfig(
      {
        "docs/index.md": "# Home\n",
        "guides/intro.md": "---\ntitle: Intro\n---\n# Intro\n",
      },
      // Two filesystem sources rooted in different trees can't share one
      // collection base, so the second source's ids would 404 at runtime.
      `export default {
        content: {
          sources: [
            { type: "filesystem", root: "docs" },
            { type: "filesystem", root: "guides", prefix: "guides" },
          ],
        },
      };\n`
    );

    const project = await scanProject(root, { mode: "build" });
    expect(project.diagnostics.map((d) => d.code)).toContain(
      "BLUME_ENTRY_ID_MISMATCH"
    );
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
    // Static fixture paths for a source-context shape assertion; nothing is
    // written to these tmp paths, so the world-writable-dir warning is moot.
    /* oxlint-disable sonarjs/publicly-writable-directories */
    const ctx: SourceContext = {
      cacheDir: "/tmp/x",
      mode: "dev",
      projectRoot: "/tmp",
    };
    /* oxlint-enable sonarjs/publicly-writable-directories */
    expect(mdxRemoteSource(base, ctx).watch).toBeUndefined();
    expect(
      mdxRemoteSource({ ...base, pollInterval: 30 }, ctx).watch
    ).toBeInstanceOf(Function);
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
    const failing = asFetch(() =>
      Promise.reject(new Error("should not fetch"))
    );
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
    expect(dispose).toBeInstanceOf(Function);
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
    expect(dispose).toBeInstanceOf(Function);
    expect(() => dispose?.()).not.toThrow();
  });
});

describe("contentConfigTemplate", () => {
  // SAFETY: contentConfigTemplate reads only `contentRoot` and `outDir` from
  // the project context; the fixture provides both.
  const context = {
    contentRoot: "/p/docs",
    outDir: "/p/.blume",
  } as ProjectContext;
  // SAFETY: the template reads only `content.include` off the config; `never`
  // bridges the rest of ResolvedConfig for this two-field fixture.
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
