import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

import { join } from "pathe";
import { render } from "takumi-js";
import { container, text } from "takumi-js/helpers";

import {
  BUILT_IN_GLYPHS,
  cachedOgImage,
  renderOgImage,
} from "../src/og/card.ts";
import type { OgCardOptions } from "../src/og/card.ts";
import { resolveOgFonts } from "../src/og/derive.ts";

/** The path of a woff2 katex ships, a real font without a checked-in fixture. */
const katexFont = (file: string): string =>
  createRequire(import.meta.url).resolve(`katex/dist/fonts/${file}`);

// A real woff2 (shipped by katex) to serve as the subset bytes, so `googleFonts`
// + `render` run end-to-end without a real network fetch or a checked-in fixture.
const SUBSET_WOFF2 = readFileSync(katexFont("KaTeX_Main-Regular.woff2"));

// One `@font-face` block: a family's subset served from `file`, claiming the
// `unicode-range` given.
const face = (family: string, file: string, range: string): string =>
  `@font-face { font-family: '${family}'; font-style: normal; font-weight: 400; ` +
  `src: url(https://fonts.gstatic.com/s/${file}) format('woff2'); ` +
  `unicode-range: ${range}; }`;

// Stub `fetch` so `googleFonts` is hermetic: a css2 request returns `css`, and
// any subset URL returns the woff2 bytes. Hands the test the css2 requests (to
// assert the metadata is fetched once) and the subset files downloaded. Mirrors
// `withStubbedGlyphFetch`, and shields against Bun's fetch retaining a proxy.
const withStubbedFonts = async (
  body: (css2Requests: string[], files: string[]) => Promise<void>,
  css = face("Noto Sans JP", "notosansjp/x.woff2", "U+0000-00FF, U+3040-30FF")
): Promise<void> => {
  const original = globalThis.fetch;
  const css2Requests: string[] = [];
  const files: string[] = [];
  // SAFETY: the font pipeline only calls fetch(url); fetch's static
  // properties (e.g. Bun's preconnect) are never touched by the code under
  // test.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("css2")) {
      css2Requests.push(url);
      return Promise.resolve(
        new Response(css, { headers: { "Content-Type": "text/css" } })
      );
    }
    files.push(url.slice(url.indexOf("/s/") + 3));
    return Promise.resolve(
      new Response(SUBSET_WOFF2, { headers: { "Content-Type": "font/woff2" } })
    );
  }) as typeof fetch;
  try {
    await body(css2Requests, files);
  } finally {
    globalThis.fetch = original;
  }
};

const expectPng = async (options: OgCardOptions): Promise<void> => {
  const buffer = await renderOgImage(options);
  expect(buffer).toBeInstanceOf(Uint8Array);
  expect(buffer.length).toBeGreaterThan(0);
};

// A square logo whose viewBox aspect keeps the mark within MARK_MAX_WIDTH, and
// carries `currentColor` so logoMark's foreground repaint runs.
const SQUARE_LOGO =
  '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="currentColor" /></svg>';
// A wide wordmark: 400x40 → computed width 320 > MARK_MAX_WIDTH, forcing the
// down-scale branch.
const WIDE_LOGO =
  '<svg viewBox="0 0 400 40"><rect fill="currentColor" height="40" width="400" /></svg>';
// No viewBox → the aspect match is null and width falls back to MARK_HEIGHT.
const NO_VIEWBOX_LOGO =
  '<svg height="24" width="24"><path d="M0 0h24v24H0z" fill="currentColor" /></svg>';

const filledLogo = (fill: string): string =>
  `<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="${fill}" /></svg>`;

// Takumi's twemoji provider fetches each glyph SVG from a CDN. Stub it so emoji
// tests are hermetic — and immune to Bun's fetch keeping a once-seen HTTPS_PROXY
// for the rest of the process (the openapi proxy test would otherwise poison
// them). Returns the fetched URLs so a test can assert on the request count.
const withStubbedGlyphFetch = async (
  body: (urls: string[]) => Promise<void>
): Promise<void> => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  // SAFETY: the twemoji provider only calls fetch(url); fetch's static
  // properties (e.g. Bun's preconnect) are never touched by the code under
  // test.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18" fill="#e00"/></svg>',
        { headers: { "Content-Type": "image/svg+xml" } }
      )
    );
  }) as typeof fetch;
  try {
    await body(urls);
  } finally {
    globalThis.fetch = original;
  }
};

// 46 chars: past the 40-char threshold but within 60 (titleSize → 64).
const MEDIUM_TITLE = "Documentation for the Blume framework here now";
// Well past 60 chars (titleSize → 52).
const LONG_TITLE =
  "The complete guide to building fast markdown documentation sites with Blume";
// Past 140 chars so truncate trims it inside the body.
const LONG_DESCRIPTION =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud.";

describe("renderOgImage", () => {
  it("renders a minimal card (no logo, brand, description, or footer)", async () => {
    await expectPng({ title: "Hi" });
  });

  it("renders a brand lockup with the accent initial mark", async () => {
    await expectPng({ accent: "purple", brand: "Acme", title: "Short" });
  });

  it("renders an emoji-leading brand without splitting the surrogate pair", async () => {
    await withStubbedGlyphFetch(async () => {
      // `charAt(0)` used to emit a lone surrogate half, blanking the mark.
      await expectPng({ brand: "🚀 Rocket Docs", title: "Hi" });
    });
  });

  it("fetches a repeated emoji glyph once across renders", async () => {
    // One card is prerendered per page, so an emoji in the site title would
    // refetch the same glyph for every page without the shared cache. Uses an
    // emoji no other test renders, so the assertion counts only these renders.
    await withStubbedGlyphFetch(async (urls) => {
      await expectPng({ brand: "🦊 Fox Docs", title: "One" });
      await expectPng({ brand: "🦊 Fox Docs", title: "Two" });
      await expectPng({ brand: "🦊 Fox Docs", title: "Three" });
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("1f98a");
    });
  });

  it("renders a square currentColor logo, hex accent, and long description", async () => {
    await expectPng({
      accent: "#123456",
      description: LONG_DESCRIPTION,
      logo: SQUARE_LOGO,
      title: MEDIUM_TITLE,
    });
  });

  it("renders a custom logo and palette", async () => {
    await expectPng({
      brand: "Acme",
      description: "Branded documentation.",
      logo: SQUARE_LOGO,
      palette: {
        accent: "#ff5410",
        background: "#1d1d1d",
        border: "#323232",
        foreground: "#fff6f2",
        muted: "#a6a19f",
      },
      repo: "acme/docs",
      site: "docs.acme.com",
      title: "Getting started",
    });
  });

  it("scales down a wide wordmark logo and a long title", async () => {
    await expectPng({ logo: WIDE_LOGO, title: LONG_TITLE });
  });

  it("renders a logo-only header, ignoring the brand label", async () => {
    // The header is logo only: a wordmark logo already spells the name, and
    // a brand label beside it duplicated it ("Ultracite  Ultracite").
    await expectPng({ brand: "Ultracite", logo: WIDE_LOGO, title: "Hi" });
  });

  it("falls back to MARK_HEIGHT width for a logo without a viewBox", async () => {
    await expectPng({ logo: NO_VIEWBOX_LOGO, title: "Hi" });
  });

  it("falls back to a square mark when the logo has no readable size", async () => {
    // Markup with no width/height and no viewBox has no measurable size; the
    // aspect falls back to null and the mark renders square.
    await expectPng({
      logo: '<svg><path d="M0 0h24v24H0z" fill="currentColor" /></svg>',
      title: "Hi",
    });
  });

  it("renders no brand mark when logo is false", async () => {
    // Without a logo the accent-initial tile stands in; `logo: false` must
    // suppress that fallback too, so the two renders cannot be identical.
    const withTile = await renderOgImage({ brand: "Acme", title: "Hi" });
    const without = await renderOgImage({
      brand: "Acme",
      logo: false,
      title: "Hi",
    });
    expect(Buffer.from(withTile).equals(Buffer.from(without))).toBe(false);
  });

  it("renders a footer with only a repo", async () => {
    await expectPng({ repo: "owner/repo", title: "Hi" });
  });

  it("renders a footer with only a site", async () => {
    await expectPng({ site: "docs.acme.com", title: "Hi" });
  });

  it("renders a footer with both repo and site and an unknown accent", async () => {
    await expectPng({
      accent: "chartreuse",
      description: "A short description.",
      repo: "owner/repo",
      site: "docs.acme.com",
      title: "Hi",
    });
  });

  it("hands non-preset accents to Takumi's CSS color parser", async () => {
    // Anything beyond the named presets passes through verbatim; Takumi
    // parses the full CSS color grammar.
    await expectPng({ accent: "oklch(0.7 0.15 200)", brand: "A", title: "Hi" });
    await expectPng({ accent: "rebeccapurple", brand: "A", title: "Hi" });
  });

  it("fails the render on a malformed accent", async () => {
    // Deliberate fail-fast: a color typo surfaces as a build error naming the
    // value instead of silently shipping a default-colored card.
    await expect(
      renderOgImage({ accent: "#12345", brand: "Acme", title: "Hi" })
    ).rejects.toThrow("#12345");
    // A prototype member name must not resolve up the preset chain into a
    // function; it reaches Takumi as a (rejected) color string instead.
    await expect(
      renderOgImage({ accent: "constructor", brand: "Acme", title: "Hi" })
    ).rejects.toThrow("constructor");
  });

  it("paints an xmlns-less logo instead of silently rendering blank", async () => {
    // Takumi's SVG parser draws nothing without a root xmlns; logoMark injects
    // one. If the logo went blank, both renders would produce identical pixels.
    const red = await renderOgImage({
      logo: filledLogo("#ff0000"),
      title: "Hi",
    });
    const blue = await renderOgImage({
      logo: filledLogo("#0000ff"),
      title: "Hi",
    });
    expect(Buffer.from(red).equals(Buffer.from(blue))).toBe(false);
  });

  it("reads a single-quoted viewBox for the aspect ratio", async () => {
    await expectPng({
      logo: '<svg viewBox=\'0 0 400 40\'><rect fill="currentColor" height="40" width="400" /></svg>',
      title: "Hi",
    });
  });

  it("loads a Google Font family so a non-Latin title isn't tofu", async () => {
    // The fix for #62: `googleFonts` fetches a family that covers the script and
    // `render` registers the subsets the title uses. The object form exercises
    // the weight/style fields.
    await withStubbedFonts(async () => {
      await expectPng({
        fonts: [{ name: "Noto Sans JP", style: "normal", weight: 400 }],
        title: "こんにちは",
      });
    });
  });

  it("fetches the css2 metadata once across cards with the same fonts", async () => {
    // A build prerenders one card per page, so the same family set must not
    // refetch the css2 metadata per card. Two renders exercise both the
    // cache-miss and cache-hit branches of loadFonts. Uses a family no other
    // test loads, since `googleFonts` keeps a process-wide css2 cache.
    await withStubbedFonts(async (css2Requests) => {
      await expectPng({ fonts: ["Noto Sans KR"], title: "안녕하세요" });
      await expectPng({ fonts: ["Noto Sans KR"], title: "감사합니다" });
      expect(css2Requests).toHaveLength(1);
    });
  });

  it("retries the css2 metadata after a failed fetch", async () => {
    // A long-lived `blume dev` renders cards for as long as it runs, so one
    // failed request must not fail every later card that needs the same
    // fonts. Uses a family no other test loads, since `googleFonts` keeps a
    // process-wide css2 cache.
    const original = globalThis.fetch;
    const css2Requests: string[] = [];
    // SAFETY: the font pipeline only calls fetch(url); fetch's static
    // properties (e.g. Bun's preconnect) are never touched by the code under
    // test.
    globalThis.fetch = ((input: RequestInfo | URL) => {
      css2Requests.push(String(input));
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof fetch;
    try {
      await expect(
        renderOgImage({ fonts: ["Noto Sans Thai"], title: "สวัสดี" })
      ).rejects.toThrow("HTTP 404");
    } finally {
      globalThis.fetch = original;
    }
    expect(css2Requests).toHaveLength(1);
    await withStubbedFonts(async (retried) => {
      await expectPng({ fonts: ["Noto Sans Thai"], title: "สวัสดี" });
      expect(retried).toHaveLength(1);
    });
  });

  it("loads a local font file without touching the network", async () => {
    // Local entries are read from disk (a real woff2 shipped by katex), so no
    // fetch stub is needed — any network call here would hit the real fetch
    // and fail loudly in CI.
    await expectPng({
      fonts: [
        {
          name: "Local Main",
          src: createRequire(import.meta.url).resolve(
            "katex/dist/fonts/KaTeX_Main-Regular.woff2"
          ),
          style: "normal",
          weight: 400,
        },
      ],
      title: "Local face",
    });
  });

  it("mixes Google families and local files in one render", async () => {
    await withStubbedFonts(async () => {
      await expectPng({
        description: "Body text in the local face.",
        families: { body: "Local Main", title: "Noto Sans JP" },
        fonts: [
          "Noto Sans JP",
          {
            name: "Local Main",
            src: createRequire(import.meta.url).resolve(
              "katex/dist/fonts/KaTeX_Main-Regular.woff2"
            ),
          },
        ],
        repo: "acme/docs",
        site: "docs.acme.com",
        title: "こんにちは",
      });
    });
  });

  it("rejects when a local font file is missing", async () => {
    // Same fail-fast as a Google fetch failure: a broken path fails the build
    // with the file in the cause instead of silently shipping tofu.
    await expect(
      renderOgImage({
        fonts: [{ name: "Ghost", src: "/definitely/missing.woff2" }],
        title: "Hi",
      })
    ).rejects.toThrow();
  });

  it("renders curated families whose names carry a digit token", async () => {
    // `source-sans-3` and `source-serif-4` derive "Source Sans 3" and "Source
    // Serif 4". Takumi parses `fontFamily` as CSS, where an unquoted family is
    // a run of identifiers and `3` isn't one, so the card used to fail the
    // build with "invalid value for fontFamily". Runs the build's own path:
    // theme.fonts -> resolveOgFonts -> renderOgImage.
    const og = resolveOgFonts(
      {
        ogFonts: undefined,
        themeFonts: { body: "source-sans-3", display: "source-serif-4" },
        themeFontsConfigured: true,
      },
      "/site"
    );
    expect(og.families).toEqual({
      body: "Source Sans 3",
      title: "Source Serif 4",
    });
    const css = [
      face("Source Serif 4", "sourceserif4/x.woff2", "U+0000-00FF"),
      face("Source Sans 3", "sourcesans3/x.woff2", "U+0000-00FF"),
    ].join("\n");
    await withStubbedFonts(async () => {
      await expectPng({
        ...og,
        description: "Body copy in the body face.",
        repo: "acme/docs",
        site: "docs.acme.com",
        title: "Getting started",
      });
    }, css);
  });

  it("pins each role to its own face whatever the family name holds", async () => {
    // Quoting must still select the named face. A name that resolves to no
    // face falls back to the first loaded one (the control here), so each
    // card differing from it, and from the others, shows each name found its
    // own face. Each face reads its own file: the renderer registers a path
    // once.
    const fonts = [
      { name: "Control", src: katexFont("KaTeX_Fraktur-Regular.woff2") },
      { name: "3270", src: katexFont("KaTeX_Typewriter-Regular.woff2") },
      { name: "Sans 3", src: katexFont("KaTeX_SansSerif-Regular.woff2") },
      { name: 'Brand "Serif" \\ 4', src: katexFont("KaTeX_Main-Bold.woff2") },
    ];
    const card = async (family: string): Promise<string> =>
      Buffer.from(
        await renderOgImage({ families: { title: family }, fonts, title: "Hi" })
      ).toString("base64");
    const unresolved = await card("Unloaded Face");
    expect(await card("Control")).toBe(unresolved);
    const cards = [
      unresolved,
      await card("3270"),
      await card("Sans 3"),
      await card('Brand "Serif" \\ 4'),
    ];
    expect(new Set(cards).size).toBe(cards.length);
  });

  it("applies role families to a card with title and body text", async () => {
    // families only steers font-family selection; render must succeed with a
    // family name that maps to a loaded local face.
    await expectPng({
      description: "Styled body copy.",
      families: { body: "Local Main", title: "Local Main" },
      fonts: [
        {
          name: "Local Main",
          src: createRequire(import.meta.url).resolve(
            "katex/dist/fonts/KaTeX_Main-Regular.woff2"
          ),
        },
      ],
      title: "Styled title",
    });
  });
});

/**
 * A glyph drawn alone in Geist, as PNG bytes in base64. Pinned as cards pin
 * it: unpinned, Takumi tries fonts earlier tests registered first, so the
 * result would depend on which tests ran before.
 */
const drawGlyph = async (glyph: string): Promise<string> =>
  Buffer.from(
    await render(
      container({
        children: [
          text(glyph, { color: "#000", fontFamily: '"Geist"', fontSize: 32 }),
        ],
        style: {
          backgroundColor: "#fff",
          display: "flex",
          height: 48,
          width: 48,
        },
      }),
      { format: "png", height: 48, width: 48 }
    )
  ).toString("base64");

describe("renderOgImage script fallbacks", () => {
  it("draws every glyph the built-in table lists without a font", async () => {
    // The table decides when a card fetches its fallbacks, so a glyph it
    // lists but Geist lacks would ship as tofu. With no font loaded, a Han
    // character renders as the missing-glyph box.
    const tofu = await drawGlyph("日");
    const codePoints = BUILT_IN_GLYPHS.flatMap(([from, to]) =>
      Array.from({ length: to - from + 1 }, (_, index) => from + index)
    );
    const drawn = await Promise.all(
      codePoints.map((codePoint) => drawGlyph(String.fromCodePoint(codePoint)))
    );
    const missing = codePoints.filter((_, index) => drawn[index] === tofu);
    expect(missing.map((codePoint) => codePoint.toString(16))).toEqual([]);
  });

  it("fetches nothing for a card the built-in font draws", async () => {
    await withStubbedFonts(async (css2Requests, files) => {
      await expectPng({
        description: "Fast docs — “quoted” text… €5 ™ café, œuvre\nnext",
        fallbacks: ["Stub Latin"],
        repo: "acme/docs",
        site: "docs.acme.com",
        title: "Getting started",
      });
      expect(css2Requests).toEqual([]);
      expect(files).toEqual([]);
    });
  });

  it("draws stray line breaks as spaces instead of fetching fallbacks", async () => {
    // Takumi draws these as missing glyphs, and no fallback font has them
    // either, so the card lays them out as the space a line feed becomes.
    await withStubbedFonts(async (css2Requests, files) => {
      const spaced = await renderOgImage({
        description: "One two three four five",
        fallbacks: ["Stub Latin"],
        title: "Line one two",
      });
      const broken = await renderOgImage({
        description: "One\vtwo\u0085three\u2028four\u2029five",
        fallbacks: ["Stub Latin"],
        title: "Line\u2028one\u2029two",
      });
      expect(Buffer.from(broken).equals(Buffer.from(spaced))).toBe(true);
      expect(css2Requests).toEqual([]);
      expect(files).toEqual([]);
    });
  });

  it("fetches nothing for emoji, which render as images", async () => {
    await withStubbedGlyphFetch(async (urls) => {
      await expectPng({ fallbacks: ["Stub Emoji"], title: "Ship it 🚀✨" });
      expect(urls.some((url) => url.includes("css2"))).toBe(false);
    });
  });

  it("loads a CJK character from the first family that claims it", async () => {
    // Google slices CJK fonts by the glyphs each really has, so the later
    // families' slices for the same characters are never downloaded, nor is
    // a slice of the first family claiming none of them. A family claiming
    // none of a card's glyphs loads nothing.
    const css = [
      face("Stub JP", "jp.woff2", "U+3040-30FF"),
      face("Stub JP", "jp-han.woff2", "U+4E00-9FFF"),
      face("Stub KR", "kr.woff2", "U+3040-30FF, U+AC00-D7A3"),
      face("Stub Thai", "thai.woff2", "U+0E00-0E7F"),
    ].join("\n");
    await withStubbedFonts(async (_, files) => {
      const fallbacks = ["Stub JP", "Stub KR", "Stub Thai"];
      await expectPng({ fallbacks, title: "こんにちは" });
      expect(files).toEqual(["jp.woff2"]);
      await expectPng({ fallbacks, title: "こんにちは 한국어" });
      expect(files).toEqual(["jp.woff2", "kr.woff2"]);
    }, css);
  });

  it("loads every family claiming a glyph outside the CJK scripts", async () => {
    // Named subsets claim a shared range whatever the font holds, so a claim
    // there proves nothing and Takumi's per-glyph fallback decides.
    const css = [
      face("Stub Arrows A", "arrows-a.woff2", "U+2190-21FF"),
      face("Stub Arrows B", "arrows-b.woff2", "U+2190-21FF"),
    ].join("\n");
    await withStubbedFonts(async (_, files) => {
      await expectPng({
        fallbacks: ["Stub Arrows A", "Stub Arrows B"],
        title: "Before → after",
      });
      expect(files.toSorted()).toEqual(["arrows-a.woff2", "arrows-b.woff2"]);
    }, css);
  });
});

describe("cachedOgImage", () => {
  it("stores a rendered card and serves it back on the next request", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "blume-og-cached-")), "og");
    try {
      const cache = { dir, version: "test" };
      const first = await cachedOgImage(cache, { brand: "Acme", title: "Hi" });
      expect(first.length).toBeGreaterThan(0);
      expect(await readdir(dir)).toHaveLength(1);
      const second = await cachedOgImage(cache, { brand: "Acme", title: "Hi" });
      expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
