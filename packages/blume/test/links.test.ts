import { describe, expect, it } from "vitest";

import { extractLinks } from "../src/core/content.ts";
import { validateLinks } from "../src/core/links.ts";
import { pageMetaSchema } from "../src/core/schema.ts";
import type {
  ContentGraph,
  Heading,
  PageLink,
  PageRecord,
} from "../src/core/types.ts";

const link = (target: string): PageLink => ({ column: 1, line: 1, target });

const heading = (text: string, slug: string): Heading => ({
  depth: 2,
  slug,
  text,
});

const makePage = (
  over: Pick<PageRecord, "id" | "route"> & Partial<PageRecord>
): PageRecord => ({
  contentType: "doc",
  format: "mdx",
  groups: [],
  headings: [],
  links: [],
  meta: pageMetaSchema.parse({}),
  segments: [],
  sourcePath: `/abs/${over.id}`,
  title: over.id,
  ...over,
});

const makeGraph = (pages: PageRecord[]): ContentGraph =>
  ({
    diagnostics: [],
    navigation: { sidebar: [], tabs: [] },
    pages,
    routes: new Map(pages.map((page) => [page.route, page.id])),
  }) as ContentGraph;

const validate = (pages: PageRecord[]) =>
  validateLinks(makeGraph(pages), { publicDir: null });

describe(extractLinks, () => {
  it("records the line and column of each link target", () => {
    const body = [
      "# Title",
      "",
      "See [the guide](/guides/intro) for more.",
    ].join("\n");
    const links = extractLinks(body);
    expect(links).toStrictEqual([
      { column: 17, line: 3, target: "/guides/intro" },
    ]);
  });

  it("skips links inside fenced code blocks", () => {
    const body = ["```md", "[x](/nope)", "```", "[y](/yes)"].join("\n");
    expect(extractLinks(body).map((l) => l.target)).toStrictEqual(["/yes"]);
  });
});

describe(validateLinks, () => {
  it("flags a broken internal link as an error", async () => {
    const diagnostics = await validate([
      makePage({ id: "a.mdx", links: [link("/missing")], route: "/a" }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_BROKEN_LINK");
    expect(diagnostics[0]?.severity).toBe("error");
  });

  it("accepts a link to an existing route", async () => {
    const diagnostics = await validate([
      makePage({ id: "a.mdx", links: [link("/b")], route: "/a" }),
      makePage({ id: "b.mdx", route: "/b" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("resolves relative links against the page's directory", async () => {
    const diagnostics = await validate([
      makePage({
        id: "guides/intro.mdx",
        links: [link("./setup"), link("../about")],
        route: "/guides/intro",
      }),
      makePage({ id: "guides/setup.mdx", route: "/guides/setup" }),
      makePage({ id: "about.mdx", route: "/about" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("warns on a missing anchor but accepts a real heading", async () => {
    const target = makePage({
      headings: [heading("Setup", "setup")],
      id: "b.mdx",
      route: "/b",
    });
    const diagnostics = await validate([
      makePage({
        id: "a.mdx",
        links: [link("/b#setup"), link("/b#nope")],
        route: "/a",
      }),
      target,
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_BROKEN_ANCHOR");
    expect(diagnostics[0]?.severity).toBe("warning");
  });

  it("validates same-page anchors against the page's own headings", async () => {
    const diagnostics = await validate([
      makePage({
        headings: [heading("Intro", "intro")],
        id: "a.mdx",
        links: [link("#intro"), link("#ghost")],
        route: "/a",
      }),
    ]);
    expect(diagnostics.map((d) => d.code)).toStrictEqual([
      "BLUME_BROKEN_ANCHOR",
    ]);
  });

  it("reports an info note for asset links when no public dir exists", async () => {
    const diagnostics = await validate([
      makePage({ id: "a.mdx", links: [link("/logo.png")], route: "/a" }),
    ]);
    expect(diagnostics.map((d) => d.code)).toStrictEqual([
      "BLUME_ASSETS_UNCHECKED",
    ]);
    expect(diagnostics[0]?.severity).toBe("info");
  });

  it("skips external, mailto, and tel links by default", async () => {
    const diagnostics = await validate([
      makePage({
        id: "a.mdx",
        links: [
          link("https://example.com"),
          link("//cdn.example.com/x"),
          link("mailto:hi@example.com"),
          link("tel:+15551234"),
        ],
        route: "/a",
      }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });
});
