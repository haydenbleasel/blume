import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import type { LoaderContext } from "astro/loaders";
import { dirname, join } from "pathe";

import { includeHmrPlugin } from "../src/astro/include-hmr.ts";
import { evictStaleIncluders } from "../src/astro/include-refresh.ts";

/** One stored entry, as the scoped store enumerates it. */
type DataEntry = ReturnType<LoaderContext["store"]["entries"]>[number][1];

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-include-graph-"));
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

// An ejected app writes its include graph relative to the project, which is
// its Astro and Vite root; the readers resolve each entry against that root.
const RELATIVE_GRAPH = JSON.stringify({ "docs/_s.md": ["docs/index.md"] });

describe("includeHmrPlugin with a project-relative graph", () => {
  it("invalidates the including page under the Vite root", async () => {
    const root = await fixture({ "includes.json": RELATIVE_GRAPH });
    const invalidated: unknown[] = [];
    const sent: { type: string }[] = [];
    const page = { id: "index" };
    const modules = new Map([[join(root, "docs", "index.md"), [page]]]);
    const result = await includeHmrPlugin(
      join(root, "includes.json")
    ).handleHotUpdate({
      file: join(root, "docs", "_s.md"),
      server: {
        config: { root },
        environments: {
          ssr: {
            moduleGraph: {
              getModulesByFile: (file: string) => {
                const found = modules.get(file);
                return found ? new Set(found) : undefined;
              },
              invalidateModule: (mod: never) => {
                invalidated.push(mod);
              },
            },
          },
        },
        ws: {
          send: (payload: { type: "full-reload" }) => {
            sent.push(payload);
          },
        },
      },
    });
    expect(result).toEqual([]);
    expect(invalidated).toEqual([page]);
    expect(sent).toEqual([{ type: "full-reload" }]);
  });
});

describe("evictStaleIncluders with a project-relative graph", () => {
  it("resolves pages and partials against the Astro root", async () => {
    const root = await fixture({
      "docs/_s.md": "Tip.\n",
      "includes.json": RELATIVE_GRAPH,
    });
    const stored = new Map<string, DataEntry>([
      [
        "index.md",
        { data: {}, digest: "raw", filePath: "docs/index.md", id: "index.md" },
      ],
    ]);
    const meta = new Map<string, string>();
    // SAFETY: the eviction reads only `config.root`, `generateDigest`,
    // `meta.get`/`set`, and the store's `entries`/`delete`; the fake provides
    // each of them.
    const context: LoaderContext = {
      config: { root: pathToFileURL(`${root}/`) },
      generateDigest: (input: Parameters<LoaderContext["generateDigest"]>[0]) =>
        `digest(${String(input).trim()})`,
      meta: {
        get: (key: string) => meta.get(key),
        set: (key: string, value: string) => {
          meta.set(key, value);
        },
      },
      store: {
        delete: (key: string) => {
          stored.delete(key);
        },
        entries: () => [...stored.entries()],
      },
    } as never;

    expect(evictStaleIncluders(context, join(root, "includes.json"))).toEqual([
      "index.md",
    ]);
    // The digest read the partial's text, so its relative path resolved.
    expect(meta.get("blume:include-state:index.md")).toBe("digest(Tip.)");
  });
});
