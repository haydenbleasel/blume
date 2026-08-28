import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

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

// Distinct references sit on distinct lines in a real document; the dedupe in
// `validateLinks` treats same-position same-message reports as one.
const image = (target: string, line = 1): PageLink => ({
  column: 1,
  image: true,
  line,
  target,
});

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
  locale: "",
  meta: pageMetaSchema.parse({}),
  navPath: over.id,
  segments: [],
  source: { name: "filesystem", ref: over.id },
  sourcePath: `/abs/${over.id}`,
  title: over.id,
  translationKey: over.route,
  version: "",
  versionKey: over.route,
  ...over,
});

const makeGraph = (pages: PageRecord[]): ContentGraph =>
  // SAFETY: link validation reads only pages and routes; the empty nav shells
  // stand in for the graph fields it never touches.
  ({
    diagnostics: [],
    navigation: {
      featured: [],
      selectors: [],
      sidebar: [],
      tabs: [],
    },
    navigationByLocale: {},
    navigationByVersion: {},
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

  it("skips links inside tilde-fenced code blocks", () => {
    const body = ["~~~md", "[x](/nope)", "~~~", "[y](/yes)"].join("\n");
    expect(extractLinks(body).map((l) => l.target)).toStrictEqual(["/yes"]);
  });

  it("skips link syntax inside inline code spans", () => {
    // Prose that *shows* Markdown link syntax must not register a link —
    // `/nope` would otherwise fail `blume validate` as a broken link.
    const body = "Use `[label](/nope)` syntax, then see [real](/yes).";
    expect(extractLinks(body)).toStrictEqual([
      { column: 46, line: 1, target: "/yes" },
    ]);
  });

  it("reports the target column even when the label repeats it", () => {
    // The target starts after `[/a/b](`, at column 8 — not inside the label.
    expect(extractLinks("[/a/b](/a/b)")).toStrictEqual([
      { column: 8, line: 1, target: "/a/b" },
    ]);
  });

  it("keeps balanced parens in a link target", () => {
    // Wikipedia-style URLs end in `(bar)` — the target must not truncate at
    // the first `)`.
    const body = "See [wiki](https://en.wikipedia.org/wiki/Foo_(bar)).";
    expect(extractLinks(body)).toStrictEqual([
      {
        column: 12,
        line: 1,
        target: "https://en.wikipedia.org/wiki/Foo_(bar)",
      },
    ]);
  });

  it("extracts both targets of an image-wrapped link", () => {
    // The outer link target and the nested image target are both validated,
    // each with a column pointing at its own target. Only the nested target
    // is an image — the outer href resolves as a site route.
    expect(extractLinks("[![alt](/img.png)](/target)")).toStrictEqual([
      { column: 20, line: 1, target: "/target" },
      { column: 9, image: true, line: 1, target: "/img.png" },
    ]);
  });

  it("marks an image embed's target as an image", () => {
    // Validation treats image embeds and plain links differently — only the
    // former go through the image pipeline — so the `!` must be recorded.
    expect(
      extractLinks("![alt](./diagram.png) and [dl](./diagram.png)")
    ).toStrictEqual([
      { column: 8, image: true, line: 1, target: "./diagram.png" },
      { column: 32, line: 1, target: "./diagram.png" },
    ]);
  });

  it("shifts recorded lines by the supplied offset", () => {
    // The body passed in is frontmatter-stripped; the offset re-anchors the
    // recorded lines to the raw file so diagnostics point at the right line.
    const body = ["intro", "[x](/a)"].join("\n");
    expect(extractLinks(body, 4)).toStrictEqual([
      { column: 5, line: 6, target: "/a" },
    ]);
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

  it("accepts a link to a configured redirect's `from` path", async () => {
    // `/providers` has no page (it redirects to `/providers/openai` at runtime),
    // so it must not be flagged broken.
    const diagnostics = await validateLinks(
      makeGraph([
        makePage({ id: "a.mdx", links: [link("/providers")], route: "/a" }),
        makePage({ id: "openai.mdx", route: "/providers/openai" }),
      ]),
      { publicDir: null, redirects: [{ from: "/providers" }] }
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("still flags a link matching neither a route nor a redirect", async () => {
    const diagnostics = await validateLinks(
      makeGraph([
        makePage({ id: "a.mdx", links: [link("/nope")], route: "/a" }),
      ]),
      { publicDir: null, redirects: [{ from: "/providers" }] }
    );
    expect(diagnostics[0]?.code).toBe("BLUME_BROKEN_LINK");
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

  it("resolves relative links from an index page against its own route", async () => {
    // `guides/index.mdx` (route `/guides`) linking `./setup` must resolve to
    // `/guides/setup`, not `/setup`.
    const diagnostics = await validate([
      makePage({
        id: "guides/index.mdx",
        links: [link("./setup")],
        route: "/guides",
      }),
      makePage({ id: "guides/setup.mdx", route: "/guides/setup" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("treats a numeric-prefixed index (01-index) as an index for relative links", async () => {
    // Route mapping strips the ordering prefix and drops `index`, so
    // `guides/01-index.mdx` routes to `/guides` — `./setup` must resolve to
    // `/guides/setup` exactly as it does from a plain `index.mdx`.
    const diagnostics = await validate([
      makePage({
        id: "guides/01-index.mdx",
        links: [link("./setup")],
        route: "/guides",
      }),
      makePage({ id: "guides/setup.mdx", route: "/guides/setup" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("treats a dot-parser localized index as an index for relative links", async () => {
    // `guides/index.fr.mdx` routes to `/fr/guides` with a locale-stripped
    // navPath of `guides/index.mdx` — `./setup` must resolve to
    // `/fr/guides/setup`, not `/fr/setup`. Same for a shared `index.$.mdx`.
    const diagnostics = await validate([
      makePage({
        id: "guides/index.fr.mdx",
        links: [link("./setup")],
        locale: "fr",
        navPath: "guides/index.mdx",
        route: "/fr/guides",
      }),
      makePage({
        id: "guides/setup.fr.mdx",
        locale: "fr",
        navPath: "guides/setup.mdx",
        route: "/fr/guides/setup",
      }),
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

  it("accepts a case-sensitive [#custom-id] anchor exactly", async () => {
    const target = makePage({
      // A pinned id may carry uppercase, which the lowercase-lenient fallback
      // for slugger-generated ids would miss.
      headings: [heading("Install", "My-Anchor")],
      id: "b.mdx",
      route: "/b",
    });
    const diagnostics = await validate([
      makePage({
        id: "a.mdx",
        links: [link("/b#My-Anchor")],
        route: "/a",
      }),
      target,
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("accepts percent-encoded links to non-ASCII routes and anchors", async () => {
    const target = makePage({
      headings: [heading("Café", "café")],
      id: "café.mdx",
      route: "/café",
    });
    const diagnostics = await validate([
      makePage({
        id: "a.mdx",
        // Browser-copied forms of /café and #café.
        links: [link("/caf%C3%A9"), link("/caf%C3%A9#caf%C3%A9")],
        route: "/a",
      }),
      target,
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("keeps a malformed percent-encoded target verbatim and reports it broken", async () => {
    // `%E0%A4%A` is a truncated multi-byte sequence — decodeURIComponent
    // throws, so the target must stay verbatim instead of crashing validation.
    const diagnostics = await validate([
      makePage({
        id: "a.mdx",
        links: [link("/caf%E0%A4%A")],
        route: "/a",
      }),
      makePage({ id: "café.mdx", route: "/café" }),
    ]);
    expect(diagnostics.map((d) => d.code)).toStrictEqual(["BLUME_BROKEN_LINK"]);
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

  it("normalizes index and trailing-slash targets, and strips query strings", async () => {
    const diagnostics = await validate([
      makePage({
        id: "a.mdx",
        links: [link("/b/"), link("/b/index"), link("/b?ref=nav")],
        route: "/a",
      }),
      makePage({ id: "b.mdx", route: "/b" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("accepts links to extra known routes (custom pages, generated routes)", async () => {
    // A custom `pages/index.astro` and the generated `/changelog` index are
    // servable but absent from the content graph — extraRoutes marks them known.
    const diagnostics = await validateLinks(
      makeGraph([
        makePage({
          id: "a.mdx",
          links: [link("/"), link("/changelog")],
          route: "/a",
        }),
      ]),
      { extraRoutes: ["/", "/changelog"], publicDir: null }
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("accepts an anchor on an extra route without checking it", async () => {
    // Headings of custom `.astro` pages aren't indexed, so a fragment there
    // must not be false-flagged as a broken anchor.
    const diagnostics = await validateLinks(
      makeGraph([
        makePage({ id: "a.mdx", links: [link("/#hero")], route: "/a" }),
      ]),
      { extraRoutes: ["/"], publicDir: null }
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("still flags links outside both the graph and the extra routes", async () => {
    const diagnostics = await validateLinks(
      makeGraph([
        makePage({ id: "a.mdx", links: [link("/nope")], route: "/a" }),
      ]),
      { extraRoutes: ["/"], publicDir: null }
    );
    expect(diagnostics.map((d) => d.code)).toStrictEqual(["BLUME_BROKEN_LINK"]);
  });
});

describe("validateLinks — assets against a public dir", () => {
  let root: string;
  let publicDir: string;
  let contentDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "blume-links-"));
    publicDir = join(root, "public");
    contentDir = join(root, "content");
    // `folder.png` is a *directory* named like an image; `screenshot.png` and
    // `diagram.png` are real files a page under guides/ can reference.
    await mkdir(join(contentDir, "guides", "folder.png"), { recursive: true });
    await mkdir(join(contentDir, "images"), { recursive: true });
    await mkdir(publicDir, { recursive: true });
    await writeFile(join(publicDir, "logo.png"), "binary");
    await writeFile(join(contentDir, "guides", "screenshot.png"), "binary");
    await writeFile(join(contentDir, "guides", "my photo.png"), "binary");
    await writeFile(join(contentDir, "images", "diagram.png"), "binary");
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const validateWithPublic = (pages: PageRecord[]) =>
    validateLinks(makeGraph(pages), { publicDir });

  it("accepts an asset that exists in the public directory", async () => {
    const diagnostics = await validateWithPublic([
      makePage({ id: "a.mdx", links: [link("/logo.png")], route: "/a" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("warns when a referenced asset is missing", async () => {
    const diagnostics = await validateWithPublic([
      makePage({ id: "a.mdx", links: [link("/missing.png")], route: "/a" }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_BROKEN_ASSET");
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.suggestion).toContain("public/missing.png");
  });

  it("treats a dotted route as a page, not a missing asset", async () => {
    // `/releases/v1.0` looks like a file (`.0`) but is a real route — the
    // route check must win over the asset heuristic.
    const diagnostics = await validateWithPublic([
      makePage({ id: "a.mdx", links: [link("/releases/v1.0")], route: "/a" }),
      makePage({ id: "releases/v1.0.mdx", route: "/releases/v1.0" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  const guidePage = (links: PageLink[]) =>
    makePage({
      id: "guides/a.mdx",
      links,
      route: "/guides/a",
      sourcePath: join(contentDir, "guides", "a.mdx"),
    });

  it("reports a partial's missing colocated image as the author wrote it", async () => {
    // Expansion rebased the partial's `./diagram.png` into the including
    // page's directory; the diagnostic must invert that so the file, the
    // path, and the "next to" phrasing all describe the partial.
    const partial = join(contentDir, "_snippets", "tip.mdx");
    const diagnostics = await validateWithPublic([
      guidePage([
        { ...image("../_snippets/diagram.png"), file: partial },
        { ...image("../assets/up.png", 2), file: partial },
      ]),
    ]);
    expect(diagnostics.map((d) => d.message)).toStrictEqual([
      "Image ./diagram.png was not found next to tip.mdx.",
      "Image ../assets/up.png was not found next to tip.mdx.",
    ]);
    expect(diagnostics.every((d) => d.file === partial)).toBe(true);
  });

  it("accepts a colocated image embed that exists next to the page source", async () => {
    // A relative image embed never reaches `public/` — Astro's pipeline emits
    // it to `_astro/` from beside the content — so probing the public dir
    // alone reports a reference the built site renders.
    const diagnostics = await validateWithPublic([
      guidePage([image("./screenshot.png"), image("../images/diagram.png")]),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("still flags a plain link to a colocated image", async () => {
    // Only `![]()` embeds go through the image pipeline; a plain
    // `[text](./x.png)` href resolves as a site route and 404s on the built
    // site, so the public-dir diagnostic (and its suggestion) stays correct.
    const diagnostics = await validateWithPublic([
      guidePage([link("./screenshot.png")]),
    ]);
    expect(diagnostics.map((d) => d.code)).toStrictEqual([
      "BLUME_BROKEN_ASSET",
    ]);
    expect(diagnostics[0]?.suggestion).toContain(
      "public/guides/screenshot.png"
    );
  });

  it("flags an image embed whose target carries a query or fragment suffix", async () => {
    // The rewrite/serve path sees the raw target and skips `./x.png?v=2`, so
    // accepting it here would green-light a reference agents 404 on.
    const diagnostics = await validateWithPublic([
      guidePage([
        image("./screenshot.png?v=2"),
        image("./screenshot.png#frag", 2),
      ]),
    ]);
    expect(diagnostics.map((d) => d.code)).toStrictEqual([
      "BLUME_BROKEN_ASSET",
      "BLUME_BROKEN_ASSET",
    ]);
  });

  it("resolves an encoded colocated reference exactly like the rewriter", async () => {
    // One decode, same as `rewriteRelativeImages`: `%20` finds `my photo.png`,
    // a double-encoded `%2520` does not — validation must not vouch for a
    // reference the rewriter leaves verbatim.
    const diagnostics = await validateWithPublic([
      guidePage([image("./my%20photo.png"), image("./my%2520photo.png")]),
    ]);
    expect(diagnostics.map((d) => d.code)).toStrictEqual([
      "BLUME_BROKEN_ASSET",
    ]);
    expect(diagnostics[0]?.message).toContain("./my%2520photo.png");
  });

  it("rejects a case-mismatched or directory-shaped colocated reference", async () => {
    // `./Screenshot.PNG` resolves via existsSync on a case-insensitive
    // filesystem but breaks on the Linux build; `./folder.png` is a directory.
    const diagnostics = await validateWithPublic([
      guidePage([image("./Screenshot.PNG"), image("./folder.png")]),
    ]);
    expect(diagnostics.map((d) => d.code)).toStrictEqual([
      "BLUME_BROKEN_ASSET",
      "BLUME_BROKEN_ASSET",
    ]);
  });

  it("still warns when a relative image is missing from both locations", async () => {
    const diagnostics = await validateWithPublic([
      guidePage([image("./missing.png")]),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_BROKEN_ASSET");
    // The reference resolves beside the page source, so the diagnostic must
    // point there — adding the file under public/ would not fix the page.
    expect(diagnostics[0]?.message).toContain("next to a.mdx");
    expect(diagnostics[0]?.suggestion).not.toContain("public");
  });

  it("warns on a missing colocated image even without a public directory", async () => {
    // The page source dir was checked and missed — that is enough to report,
    // not to demote to the unchecked-assets info aggregate.
    const diagnostics = await validateLinks(
      makeGraph([guidePage([image("./missing.png")])]),
      { publicDir: null }
    );
    expect(diagnostics.map((d) => d.code)).toStrictEqual([
      "BLUME_BROKEN_ASSET",
    ]);
  });
});

describe("validateLinks — partial-origin links", () => {
  const partial = "/abs/_snippets/s.mdx";

  it("dedupes byte-identical diagnostics from every including page", async () => {
    // The same broken absolute link in one partial, spliced by two pages:
    // the verdict is includer-independent, so one report carries it.
    const partialLink: PageLink = {
      column: 3,
      file: partial,
      line: 2,
      target: "/nope",
    };
    const diagnostics = await validate([
      makePage({ id: "a.mdx", links: [{ ...partialLink }], route: "/a" }),
      makePage({ id: "b.mdx", links: [{ ...partialLink }], route: "/b" }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(partial);
    expect(diagnostics[0]?.message).not.toContain("included by");
  });

  it("names the including page when a relative link's verdict depends on it", async () => {
    // `./setup` resolves from each includer's own route: valid from the
    // top-level page, broken from the nested one — so the report must say
    // which splice broke.
    const relativeLink: PageLink = {
      column: 1,
      file: partial,
      line: 1,
      target: "./setup",
    };
    const diagnostics = await validate([
      makePage({ id: "setup.mdx", route: "/setup" }),
      makePage({ id: "a.mdx", links: [{ ...relativeLink }], route: "/a" }),
      makePage({
        id: "deep/b.mdx",
        links: [{ ...relativeLink }],
        route: "/deep/b",
      }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(partial);
    expect(diagnostics[0]?.message).toContain("(included by b.mdx)");
  });

  it("names the including page for a partial's broken bare anchor", async () => {
    const anchorLink: PageLink = {
      column: 1,
      file: partial,
      line: 4,
      target: "#missing",
    };
    const diagnostics = await validate([
      makePage({ id: "a.mdx", links: [{ ...anchorLink }], route: "/a" }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_BROKEN_ANCHOR");
    expect(diagnostics[0]?.message).toContain("(included by a.mdx)");
  });

  it("keeps page-authored diagnostics free of includer context", async () => {
    const diagnostics = await validate([
      makePage({
        id: "a.mdx",
        links: [{ column: 1, line: 1, target: "./gone" }],
        route: "/a",
      }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).not.toContain("included by");
  });
});
