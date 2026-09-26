import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildAskData } from "../src/ai/ask-data.ts";
import { buildMcpData } from "../src/ai/mcp/data.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { pageMetaSchema } from "../src/core/schema.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";
import { buildOramaIndex, queryOramaIndex } from "../src/search/orama-index.ts";
import type { OramaDoc } from "../src/search/orama-index.ts";
import { pagefindRanking } from "../src/search/pagefind-ranking.ts";

/**
 * A page's `search.boost` and `search.keywords`: validated as frontmatter,
 * carried into every index, and ranked by the default Orama search (and the
 * MCP and assistant tools that share it) and by Pagefind.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const BODY =
  "Widgets are set up in the widget file. Each widget has a name and a size.";

const DOCS: OramaDoc[] = [
  { content: BODY, description: "", route: "/alpha", title: "Alpha" },
  { boost: 5, content: BODY, description: "", route: "/bravo", title: "Bravo" },
  {
    content: "Something else entirely.",
    description: "",
    keywords: ["gizmo"],
    route: "/charlie",
    title: "Charlie",
  },
  {
    boost: 0.5,
    content: BODY,
    description: "",
    route: "/delta",
    title: "Delta",
  },
];

const routes = async (docs: OramaDoc[], term: string): Promise<string[]> => {
  const found = await queryOramaIndex(await buildOramaIndex(docs), term, 10);
  return found.map((doc) => doc.route);
};

describe("ranking in the Orama index", () => {
  it("multiplies each match's relevance by its page's boost", async () => {
    expect(await routes(DOCS, "widget")).toStrictEqual([
      "/bravo",
      "/alpha",
      "/delta",
    ]);
    // Without boosts, equal matches keep their document order.
    const plain = DOCS.map(({ boost: _boost, ...doc }) => doc);
    expect(await routes(plain, "widget")).toStrictEqual([
      "/alpha",
      "/bravo",
      "/delta",
    ]);
  });

  it("finds a page by its keywords", async () => {
    expect(await routes(DOCS, "gizmo")).toStrictEqual(["/charlie"]);
  });
});

describe(pagefindRanking, () => {
  it("weights a boosted page's body and carries its keywords", () => {
    expect(pagefindRanking({ boost: 5, keywords: ["a", "b"] })).toStrictEqual({
      keywords: "a b",
      weight: "5",
    });
    // Pagefind's weight tops out at 10.
    expect(pagefindRanking({ boost: 20 })).toStrictEqual({ weight: "10" });
    expect(pagefindRanking({ boost: 1, keywords: [] })).toStrictEqual({});
    expect(pagefindRanking({})).toStrictEqual({});
  });
});

/** Whether a page's frontmatter accepts `search`. */
const accepts = (search: { boost?: number; keywords?: string[] }): boolean =>
  pageMetaSchema.safeParse({ search }).success;

describe("search frontmatter", () => {
  it("takes any positive boost, and keywords", () => {
    expect(accepts({ boost: 0.5 })).toBe(true);
    expect(accepts({ boost: 20, keywords: ["setup"] })).toBe(true);
    expect(accepts({ boost: 0 })).toBe(false);
  });
});

describe("boost and keywords in the indexes", () => {
  it("reach the search documents, the MCP server, and the assistant", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-search-ranking-"));
    dirs.push(root);
    const files = {
      "docs/index.md": "---\ntitle: Home\nsearch:\n  boost: 1\n---\n\nHome.\n",
      "docs/setup.md":
        "---\ntitle: Setup\nsearch:\n  boost: 3\n  keywords: [install]\n---\n\nSet it up.\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([path, content]) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content, "utf-8");
      })
    );
    const project = await scanProject(root, { mode: "build" });
    const expected = { boost: 3, keywords: ["install"], route: "/setup" };

    const documents = await buildSearchDocuments(project);
    expect(documents.find((doc) => doc.route === "/setup")).toMatchObject(
      expected
    );
    // A boost of 1 is no boost, and no keywords is none.
    const home = documents.find((doc) => doc.route === "/");
    expect(home?.boost).toBeUndefined();
    expect(home?.keywords).toBeUndefined();

    const mcp = await buildMcpData(project);
    expect(mcp.documents.find((doc) => doc.route === "/setup")).toMatchObject(
      expected
    );
    const ask = await buildAskData(project);
    expect(ask.documents.find((doc) => doc.route === "/setup")).toMatchObject(
      expected
    );
  });
});
