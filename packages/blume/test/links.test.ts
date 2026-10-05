import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { extractLinks } from "../src/core/content.ts";
import {
  isIndexFileName,
  resolveRelativeHref,
  validateLinks,
} from "../src/core/links.ts";
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

// A lowercase `<a href>`, which ships as written.
const raw = (target: string, line: number): PageLink => ({
  column: 1,
  line,
  raw: true,
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
  anchors: [],
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

  it("reads a component's string href, even wrapped onto its own line", () => {
    const body = [
      'Inline <Card title="x" href="./install" /> and <abbr href="./no">a</abbr>.',
      "<Card",
      '  title="Wrapped"',
      "  href='../setup.mdx#run'",
      ">",
      "</Card>",
      '`<Card href="./code" />`, <Card href={props.target} />',
      "```mdx",
      '<Card href="./fenced" />',
      "```",
    ].join("\n");
    expect(extractLinks(body, 4)).toStrictEqual([
      { column: 30, line: 5, target: "./install" },
      { column: 9, line: 8, target: "../setup.mdx#run" },
    ]);
  });

  it("reads a lowercase <a href> as a raw link", () => {
    // Raw HTML in `.md` (plain JSX in `.mdx`) ships as written, so its
    // target is marked raw: checked the way the browser reads it.
    const body = [
      'An <a href="./raw">inline</a> tag and',
      '<a class="x"',
      "  href='/wrapped#top'>a wrapped one</a>.",
    ].join("\n");
    expect(extractLinks(body)).toStrictEqual([
      { column: 13, line: 1, raw: true, target: "./raw" },
      { column: 9, line: 3, raw: true, target: "/wrapped#top" },
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

  it("reads a reference-style link's definition", () => {
    // `[text][guide]` renders with the definition's destination, so that's
    // the target to check. A footnote definition isn't a link, and neither
    // is a label with no destination.
    const body = [
      "See [the guide][guide] and [Setup].",
      "",
      '[guide]: /guides/intro "Intro"',
      "  [setup]: <./setup page>",
      "> [quoted]: /quoted",
      "[^1]: A footnote, not a link.",
      "[empty]: <>",
      "```md",
      "[fenced]: /nope",
      "```",
    ].join("\n");
    expect(extractLinks(body)).toStrictEqual([
      { column: 10, line: 3, target: "/guides/intro" },
      { column: 13, line: 4, target: "./setup page" },
      { column: 13, line: 5, target: "/quoted" },
    ]);
  });

  it("reads an autolink's URL", () => {
    // Only http(s) targets are ever checked, so a `mailto:` autolink isn't
    // recorded; one shown as inline code isn't a link at all.
    const body =
      "Visit <https://example.com/docs>, <mailto:a@b.dev>, or `<https://code.dev>`.";
    expect(extractLinks(body)).toStrictEqual([
      { column: 8, line: 1, target: "https://example.com/docs" },
    ]);
  });

  it("reads a link whose label wraps onto the next line", () => {
    // A formatter wraps long labels; the link still renders. A blank line
    // ends the paragraph, so brackets on either side of one are no link.
    const body = [
      "See [a long",
      "label](/wrapped) and ![an",
      "alt](./img.png).",
      "",
      "[not a link",
      "",
      "](/across-paragraphs)",
    ].join("\n");
    expect(extractLinks(body, 2)).toStrictEqual([
      { column: 8, line: 4, target: "/wrapped" },
      { column: 6, image: true, line: 5, target: "./img.png" },
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

  it("reads a raw <a href> the way the browser does", async () => {
    // A raw `./setup` on `/docs/guides` (an index page) isn't rewritten, so
    // the browser lands on `/docs/setup`; a raw `/guides/setup` isn't based,
    // so it lands outside `/docs` and is broken.
    const diagnostics = await validateLinks(
      makeGraph([
        makePage({
          id: "guides/index.mdx",
          links: [raw("./setup", 1), raw("/guides/setup", 2), link("./setup")],
          route: "/docs/guides",
        }),
        makePage({ id: "setup.mdx", route: "/docs/setup" }),
      ]),
      { basePath: "/docs", publicDir: null }
    );
    expect(
      diagnostics.map((diagnostic) => [diagnostic.line, diagnostic.message])
    ).toStrictEqual([
      [2, "Broken link to /guides/setup: no page resolves to /guides/setup."],
      [1, "Broken link to ./setup: no page resolves to /docs/guides/setup."],
    ]);
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

  describe("under i18n", () => {
    const i18n = {
      defaultLocale: "en",
      hideDefaultLocalePrefix: true,
      locales: [{ code: "en" }, { code: "fr" }],
    };
    const english = makePage({
      headings: [heading("Ordering", "ordering")],
      id: "nav.mdx",
      locale: "en",
      route: "/nav",
    });
    const french = makePage({
      headings: [heading("Ordre", "ordre")],
      id: "fr/nav.mdx",
      locale: "fr",
      route: "/fr/nav",
    });

    it("resolves a root-relative link into the page's locale, anchors included", async () => {
      // Rendered on `/fr/meta`, `/nav#ordering` lands on `/fr/nav` — whose
      // translated heading slug no longer matches, exactly what a reader hits.
      const diagnostics = await validateLinks(
        makeGraph([
          makePage({
            id: "fr/meta.mdx",
            links: [link("/nav#ordering"), link("/nav#ordre"), link("/nav")],
            locale: "fr",
            route: "/fr/meta",
          }),
          english,
          french,
        ]),
        { i18n, publicDir: null }
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.code).toBe("BLUME_BROKEN_ANCHOR");
      expect(diagnostics[0]?.message).toContain("/fr/nav");
    });

    it("accepts a link whose locale variant is a fallback route", async () => {
      // No French `nav` page: the manifest materializes `/fr/nav` as a fallback
      // (passed in `extraRoutes`), which renders the English headings — so the
      // English anchor is right and accepted unchecked.
      const diagnostics = await validateLinks(
        makeGraph([
          makePage({
            id: "fr/meta.mdx",
            links: [link("/nav#ordering")],
            locale: "fr",
            route: "/fr/meta",
          }),
          english,
        ]),
        { extraRoutes: ["/fr/nav"], i18n, publicDir: null }
      );
      expect(diagnostics).toHaveLength(0);
    });

    it("keeps the authored route when no locale variant is served", async () => {
      // Fallbacks off and no translation: the link stays on `/nav`, so the
      // English anchor is what gets checked.
      const diagnostics = await validateLinks(
        makeGraph([
          makePage({
            id: "fr/meta.mdx",
            links: [link("/nav#ordering"), link("/nav#missing")],
            locale: "fr",
            route: "/fr/meta",
          }),
          english,
        ]),
        { i18n, publicDir: null }
      );
      expect(diagnostics.map((d) => d.message)).toStrictEqual([
        "No anchor target on /nav matches #missing.",
      ]);
    });

    it("checks default-locale pages against their own routes", async () => {
      const diagnostics = await validateLinks(
        makeGraph([
          makePage({
            id: "meta.mdx",
            links: [link("/nav#ordering")],
            locale: "en",
            route: "/meta",
          }),
          english,
          french,
        ]),
        { i18n, publicDir: null }
      );
      expect(diagnostics).toHaveLength(0);
    });
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

  it("accepts a fragment that only a raw HTML id on the target provides", async () => {
    const diagnostics = await validate([
      makePage({
        id: "a.mdx",
        links: [link("/b#restart-abandonment")],
        route: "/a",
      }),
      makePage({ anchors: ["restart-abandonment"], id: "b.mdx", route: "/b" }),
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

describe(resolveRelativeHref, () => {
  const leaf = { isIndex: false, route: "/guides/setup" };
  const index = { isIndex: true, route: "/guides" };

  it("leaves everything that isn't a relative page link alone", () => {
    for (const href of [
      "",
      "#top",
      "?tab=npm",
      "/guides/install",
      "https://example.com/x",
      "mailto:a@b.dev",
      "./diagram.png",
      "../files/spec.pdf",
    ]) {
      expect(resolveRelativeHref(href, leaf)).toBeUndefined();
    }
  });

  it("resolves a leaf page's links against its parent directory", () => {
    expect(resolveRelativeHref("./install", leaf)).toBe("/guides/install");
    expect(resolveRelativeHref("install", leaf)).toBe("/guides/install");
    expect(resolveRelativeHref("../about", leaf)).toBe("/about");
    expect(resolveRelativeHref("./", leaf)).toBe("/guides");
  });

  it("resolves an index page's links against its own route", () => {
    // A browser at the slashless `/guides` would send `./install` to `/install`.
    expect(resolveRelativeHref("./install", index)).toBe("/guides/install");
    expect(resolveRelativeHref("../about", index)).toBe("/about");
    expect(
      resolveRelativeHref("./install", { isIndex: true, route: "/" })
    ).toBe("/install");
  });

  it("keeps the authored query and fragment", () => {
    expect(resolveRelativeHref("./install?tab=npm#step-2", index)).toBe(
      "/guides/install?tab=npm#step-2"
    );
    expect(resolveRelativeHref("./install#step-2", leaf)).toBe(
      "/guides/install#step-2"
    );
  });

  it("maps a .md/.mdx file link through resolveFile, decoded", () => {
    const seen: string[] = [];
    const resolveFile = (path: string) => {
      seen.push(path);
      return path === "./01-caf\u00E9.mdx" ? "/guides/cafe" : undefined;
    };
    expect(resolveRelativeHref("./01-caf%C3%A9.mdx#a", leaf, resolveFile)).toBe(
      "/guides/cafe#a"
    );
    expect(seen).toStrictEqual(["./01-caf\u00E9.mdx"]);
  });

  it("drops the extension route-relative for a file resolveFile doesn't know", () => {
    const none = new Map<string, string>();
    expect(
      resolveRelativeHref("./install.md", leaf, (path) => none.get(path))
    ).toBe("/guides/install");
    expect(resolveRelativeHref("./nested/index.mdx", index)).toBe(
      "/guides/nested"
    );
  });
});

describe(isIndexFileName, () => {
  it("recognizes an index file, ordering prefix ignored", () => {
    expect(isIndexFileName("guides/index.mdx")).toBe(true);
    expect(isIndexFileName("guides/01-index.md")).toBe(true);
    expect(isIndexFileName("guides/install.mdx")).toBe(false);
    expect(isIndexFileName("guides/indexes.mdx")).toBe(false);
  });

  it("accepts a locale token only when one is configured", () => {
    expect(isIndexFileName("index.fr.mdx", ["$", "fr"])).toBe(true);
    expect(isIndexFileName("index.$.mdx", ["$", "fr"])).toBe(true);
    expect(isIndexFileName("index.fr.mdx")).toBe(false);
    expect(isIndexFileName("index.draft.mdx", ["$", "fr"])).toBe(false);
  });
});

describe("resolveRelativeHref — dotted page names", () => {
  const from = { isIndex: true, route: "/guides" };
  const routes = new Set(["/guides/node.js", "/v1.2"]);
  const hasRoute = (route: string): boolean => routes.has(route);

  it("reads a dotted name as a page where one publishes", () => {
    expect(
      resolveRelativeHref("./node.js#run", from, undefined, hasRoute)
    ).toBe("/guides/node.js#run");
    expect(resolveRelativeHref("../v1.2", from, undefined, hasRoute)).toBe(
      "/v1.2"
    );
  });

  it("keeps any other extension an asset", () => {
    expect(
      resolveRelativeHref("./diagram.png", from, undefined, hasRoute)
    ).toBeUndefined();
    // Without a route lookup, every extension is an asset.
    expect(resolveRelativeHref("./node.js", from)).toBeUndefined();
  });
});

describe("validateLinks — relative file links", () => {
  it("resolves a .md/.mdx link to the route its file publishes at", async () => {
    // The ordering prefix and the target's own `slug` are route mapping's
    // business: the link names the file, so it lands wherever that file goes.
    const diagnostics = await validate([
      makePage({
        id: "guides/index.mdx",
        links: [
          link("./01-install.mdx"),
          link("./setup.md#run"),
          link("../about.mdx"),
        ],
        route: "/guides",
      }),
      makePage({ id: "guides/01-install.mdx", route: "/guides/install" }),
      makePage({
        headings: [heading("Run", "run")],
        id: "guides/setup.md",
        route: "/getting-started",
      }),
      makePage({ id: "about.mdx", route: "/about" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("falls back to the route-relative reading for a file it doesn't know", async () => {
    const diagnostics = await validate([
      makePage({
        id: "guides/index.mdx",
        links: [link("./missing.md")],
        route: "/guides",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain(
      "no page resolves to /guides/missing"
    );
  });

  it("resolves route-relative on a page with no source file", async () => {
    const diagnostics = await validate([
      makePage({
        id: "remote.mdx",
        links: [link("./about.md")],
        route: "/remote",
        sourcePath: undefined,
      }),
      makePage({ id: "about.mdx", route: "/about" }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it("lets a shared file's default-locale route stand for it, never a fallback copy", async () => {
    const i18n = {
      defaultLocale: "en",
      hideDefaultLocalePrefix: true,
      locales: [{ code: "en" }, { code: "fr" }],
    };
    const shared = "/abs/shared.$.mdx";
    const diagnostics = await validateLinks(
      makeGraph([
        makePage({
          id: "fr/linker.mdx",
          links: [link("./shared.$.mdx")],
          locale: "fr",
          route: "/fr/linker",
          sourcePath: "/abs/linker.mdx",
        }),
        // A fallback copy of the shared file, listed first, never stands for it.
        makePage({
          fallback: true,
          id: "copy",
          locale: "fr",
          route: "/fr/copy",
          sourcePath: shared,
        }),
        makePage({
          id: "shared-fr",
          locale: "fr",
          route: "/fr/shared",
          sourcePath: shared,
        }),
        makePage({
          id: "shared-en",
          locale: "en",
          route: "/shared",
          sourcePath: shared,
        }),
      ]),
      { i18n, publicDir: null }
    );
    // `/shared` moves into the linking page's locale, as the rendered link does.
    expect(diagnostics).toHaveLength(0);
  });

  it("reads a sibling a locale hasn't translated from the default tree", async () => {
    const i18n = {
      defaultLocale: "en",
      hideDefaultLocalePrefix: true,
      locales: [{ code: "en" }, { code: "fr" }],
    };
    const diagnostics = await validateLinks(
      makeGraph([
        makePage({
          id: "fr/guides/index.mdx",
          links: [link("./setup.mdx")],
          locale: "fr",
          navPath: "guides/index.mdx",
          route: "/fr/guides",
          sourcePath: "/abs/fr/guides/index.mdx",
        }),
        makePage({
          id: "guides/setup.mdx",
          locale: "en",
          navPath: "guides/setup.mdx",
          route: "/getting-started",
          sourcePath: "/abs/guides/setup.mdx",
        }),
        // The fallback copy the link lands on once it moves into the locale.
        makePage({
          fallback: true,
          id: "fr/guides/setup.mdx",
          locale: "fr",
          navPath: "guides/setup.mdx",
          route: "/fr/getting-started",
          sourcePath: "/abs/guides/setup.mdx",
        }),
      ]),
      { i18n, publicDir: null }
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("checks a dotted page name as the page it is", async () => {
    const diagnostics = await validate([
      makePage({
        id: "guides/index.mdx",
        links: [link("./node.js"), link("./gone.js")],
        route: "/guides",
      }),
      makePage({ id: "guides/node.js.mdx", route: "/guides/node.js" }),
    ]);
    // The page resolves; the missing one stays an (unchecked) asset.
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === "BLUME_BROKEN_LINK"
      )
    ).toHaveLength(0);
  });
});
