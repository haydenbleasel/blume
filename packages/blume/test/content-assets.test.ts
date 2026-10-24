import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  collectContentAssets,
  CONTENT_ASSETS_PREFIX,
  contentAssetParam,
  contentAssetUrl,
  rewriteRelativeAssets,
} from "../src/core/content-assets.ts";
import { resolveRelativeFile } from "../src/core/relative-files.ts";
import {
  isLinkElementUrl,
  rewriteElementUrls,
  rewriteLinkTargets,
} from "../src/core/sources/normalize.ts";

let root: string;
let pagePath: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-content-assets-"));
  await mkdir(join(root, "docs", "images"), { recursive: true });
  await mkdir(join(root, "docs", "dir.png"), { recursive: true });
  pagePath = join(root, "docs", "page.mdx");
  await Promise.all([
    writeFile(join(root, "docs", "photo.png"), "png"),
    writeFile(join(root, "docs", "images", "nested.png"), "png"),
    writeFile(join(root, "docs", "my photo.png"), "png"),
    writeFile(join(root, "shared.png"), "png"),
    writeFile(join(root, "docs", "spec.pdf"), "pdf"),
    writeFile(pagePath, "unused"),
  ]);
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const rewrite = (
  source: string,
  over: Partial<Parameters<typeof rewriteRelativeAssets>[0]> = {}
): string =>
  rewriteRelativeAssets({
    format: null,
    projectRoot: root,
    source,
    sourcePath: pagePath,
    ...over,
  });

/** A link target's served URL, when it names a file beside the page. */
const fileUrl = (target: string): string | null => {
  const file = resolveRelativeFile(join(root, "docs"), target);
  return file === null
    ? null
    : `${contentAssetUrl(contentAssetParam(root, file.path))}${file.suffix}`;
};

/**
 * The link and element-URL passes run unconditionally: what the rewrite must
 * match, whether or not a page's text has a destination that could be
 * relative.
 */
const fullPasses = (source: string): string =>
  rewriteElementUrls(
    rewriteLinkTargets(source, fileUrl, null),
    (url) => (isLinkElementUrl(url) ? fileUrl(url.value) : null),
    null
  );

/** A `.md` page that shows a comment's delimiters in indented code. */
const commentsInCode = (spec: string, img: string): string =>
  [
    "Open a comment with",
    "",
    "    <!--",
    "",
    `Download [the spec](${spec}) or see <img src="${img}">.`,
    "",
    "and close it with",
    "",
    "    -->",
    "",
  ].join("\n");

describe("rewriteRelativeAssets", () => {
  it("rewrites a colocated relative image to its served URL", () => {
    expect(rewrite("![Alt](./photo.png)")).toBe(
      `![Alt](${CONTENT_ASSETS_PREFIX}/docs/photo.png)`
    );
  });

  it("resolves ../ segments and nested folders", () => {
    const out = rewrite("![a](../shared.png) and ![b](./images/nested.png)");
    expect(out).toBe(
      `![a](${CONTENT_ASSETS_PREFIX}/shared.png) and ![b](${CONTENT_ASSETS_PREFIX}/docs/images/nested.png)`
    );
  });

  it("rewrites a bare relative path the way Astro treats one", () => {
    expect(rewrite("![Alt](photo.png)")).toBe(
      `![Alt](${CONTENT_ASSETS_PREFIX}/docs/photo.png)`
    );
  });

  it("keeps a title suffix intact", () => {
    expect(rewrite('![Alt](./photo.png "The title")')).toBe(
      `![Alt](${CONTENT_ASSETS_PREFIX}/docs/photo.png "The title")`
    );
  });

  it("reads every destination form, writing the URL back in its own", () => {
    expect(
      rewrite(
        [
          "![a](<./my photo.png>) ![b]( ./photo.png 'T' ) ![c](./photo.png (T))",
          String.raw`![d](my%20photo.png) ![e](./images/nested.png "q \" q")`,
        ].join("\n")
      )
    ).toBe(
      [
        `![a](<${CONTENT_ASSETS_PREFIX}/docs/my%20photo.png>) ![b]( ${CONTENT_ASSETS_PREFIX}/docs/photo.png 'T' ) ![c](${CONTENT_ASSETS_PREFIX}/docs/photo.png (T))`,
        String.raw`![d](${CONTENT_ASSETS_PREFIX}/docs/my%20photo.png) ![e](${CONTENT_ASSETS_PREFIX}/docs/images/nested.png "q \" q")`,
      ].join("\n")
    );
  });

  it("rewrites an image nested inside a link label", () => {
    expect(rewrite("[![Alt](./photo.png)](https://example.com)")).toBe(
      `[![Alt](${CONTENT_ASSETS_PREFIX}/docs/photo.png)](https://example.com)`
    );
  });

  it("leaves remote, public-absolute, and fragment targets alone", () => {
    const source =
      "![r](https://example.com/x.png) ![p](/public.png) ![f](#frag)";
    expect(rewrite(source)).toBe(source);
  });

  it("leaves references to missing files and non-images alone", () => {
    // `./nope/missing.png` has no parent directory at all — the resolver must
    // treat an unreadable parent the same as a missing file.
    const source =
      "![m](./missing.png) ![d](./spec.pdf) ![n](./nope/missing.png)";
    expect(rewrite(source)).toBe(source);
  });

  it("leaves case-mismatched and directory references alone", () => {
    // `./Photo.PNG` passes a bare existsSync on a case-insensitive filesystem
    // but breaks on the Linux build; `./dir.png` is a directory. Neither is a
    // servable colocated image, so neither may be rewritten.
    const source = "![c](./Photo.PNG) ![d](./dir.png)";
    expect(rewrite(source)).toBe(source);
  });

  it("leaves a malformed percent-escape target alone", () => {
    const source = "![m](./ph%zzoto.png)";
    expect(rewrite(source)).toBe(source);
  });

  it("skips fenced code blocks and inline code", () => {
    const source = [
      "![real](./photo.png)",
      "```md",
      "![example](./photo.png)",
      "```",
      "and `![inline](./photo.png)` stays",
    ].join("\n");
    const out = rewrite(source);
    expect(out).toContain(`![real](${CONTENT_ASSETS_PREFIX}/docs/photo.png)`);
    expect(out).toContain("![example](./photo.png)");
    expect(out).toContain("`![inline](./photo.png)` stays");
  });

  it("decodes an encoded source reference before resolving it", () => {
    expect(rewrite("![Alt](./my%20photo.png)")).toBe(
      `![Alt](${CONTENT_ASSETS_PREFIX}/docs/my%20photo.png)`
    );
  });

  it("prefixes the deployment base when configured", () => {
    expect(rewrite("![Alt](./photo.png)", { deployBase: "/base/" })).toBe(
      `![Alt](/base${CONTENT_ASSETS_PREFIX}/docs/photo.png)`
    );
  });

  it("reports each rewritten asset to the register callback", () => {
    const seen: Record<string, string> = {};
    rewrite("![a](./photo.png) ![b](./photo.png) ![c](../shared.png)", {
      register: (param: string, abs: string) => {
        seen[param] = abs;
      },
    });
    expect(seen).toEqual({
      "docs/photo.png": join(root, "docs", "photo.png"),
      "shared.png": join(root, "shared.png"),
    });
  });
});

describe("rewriteRelativeAssets — other files beside the page", () => {
  const served = `${CONTENT_ASSETS_PREFIX}/docs/spec.pdf`;

  it("rewrites a link, a definition, and a wrapped link to a file", () => {
    expect(
      rewrite(
        [
          "[Spec](./spec.pdf) and [page 2](<spec.pdf#page=2> 'T').",
          "[a long",
          "label](./spec.pdf)",
          "",
          "[spec]: ./spec.pdf",
          "[shot]: ./photo.png?v=2",
        ].join("\n")
      )
    ).toBe(
      [
        `[Spec](${served}) and [page 2](<${served}#page=2> 'T').`,
        "[a long",
        `label](${served})`,
        "",
        `[spec]: ${served}`,
        `[shot]: ${CONTENT_ASSETS_PREFIX}/docs/photo.png?v=2`,
      ].join("\n")
    );
  });

  it("rewrites a media src and an href, in raw HTML or a component", () => {
    expect(
      rewrite(
        [
          '<img src="./photo.png" alt="x"> <video src=\'./spec.pdf\'></video>',
          '<a href="./spec.pdf">Spec</a> <Card title="S" href="./spec.pdf" />',
          "<Card",
          '  href="./spec.pdf"',
          "/>",
        ].join("\n")
      )
    ).toBe(
      [
        `<img src="${CONTENT_ASSETS_PREFIX}/docs/photo.png" alt="x"> <video src='${served}'></video>`,
        `<a href="${served}">Spec</a> <Card title="S" href="${served}" />`,
        "<Card",
        `  href="${served}"`,
        "/>",
      ].join("\n")
    );
  });

  it("leaves page links, missing files, non-links, and code alone", () => {
    const source = [
      "[page](./page.mdx) [doc](./page.md#x) [up](../) [none](./missing.pdf)",
      "![embed](./spec.pdf) [dir](./dir.png) [web](https://x.dev/a.pdf)",
      "[^1]: spec.pdf is a footnote.",
      '<iframe src="./spec.pdf"></iframe> <a href="./page">Page</a>',
      '<Frame src="./spec.pdf" /> <a title="./spec.pdf">x</a>',
      "`[code](./spec.pdf)` and",
      "```html",
      '<a href="./spec.pdf">fenced</a>',
      "```",
    ].join("\n");
    expect(rewrite(source)).toBe(source);
  });

  it("skips comments and a .md page's indented code, given the format", () => {
    const refs =
      '![p](./photo.png) [s](./spec.pdf) <a href="./spec.pdf">s</a> <Card img="./photo.png" />';
    const md = `Text\n\n    ${refs}\n\n<!-- ${refs} -->\n`;
    expect(rewrite(md, { format: "md" })).toBe(md);
    const mdx = `{/* ${refs} */}\n`;
    expect(rewrite(mdx, { format: "mdx" })).toBe(mdx);
    // Without a format, or in MDX, which has no indented code, they're links.
    const photo = `${CONTENT_ASSETS_PREFIX}/docs/photo.png`;
    expect(rewrite(`<!-- ![p](./photo.png) -->`)).toBe(
      `<!-- ![p](${photo}) -->`
    );
    expect(rewrite(`Text\n\n    ${refs}`, { format: "mdx" })).toBe(
      `Text\n\n    ![p](${photo}) [s](${served}) <a href="${served}">s</a> <Card img="${photo}" />`
    );
  });

  it("never pairs a comment delimiter in indented code with one outside it", () => {
    // Shown as code, `<!--` opens no comment, so the file links between it
    // and a later `-->` are real, and served.
    const photo = `${CONTENT_ASSETS_PREFIX}/docs/photo.png`;
    expect(
      rewrite(commentsInCode("./spec.pdf", "./photo.png"), { format: "md" })
    ).toBe(commentsInCode(served, photo));
  });

  it("leaves a page that links only to routes and anchors as it is", () => {
    const source = [
      "[Guide](/guide) and [usage](#usage), or [top]( /).",
      "[ref]: /reference",
      '<Card title="G" href="/guide" /> <img src="/logo.png"> <a href=\'#x\'>x</a>',
    ].join("\n");
    expect(rewrite(source)).toBe(source);
  });

  it("rewrites every link and element URL the full passes rewrite", () => {
    const sources = [
      "[Guide](/guide) [usage](#usage) [web](https://x.dev/a.pdf)",
      // A code span blanks the bracket that ends the label, so the link reads
      // past it.
      "[a`]`](./spec.pdf) and [b](`x`./spec.pdf)",
      "[spaced](  ./spec.pdf) [angled](<./spec.pdf>) [escaped](\\./spec.pdf)",
      "[spec]:\t ./spec.pdf\n[route]: /spec.pdf",
      "[a long\nlabel](spec.pdf#page=2)",
      "<a href='./spec.pdf'>x</a> <video\n  src=\"spec.pdf\"></video>",
      '<img src="/logo.png"> <Card href="#x" /> <Card href="./spec.pdf" />',
    ];
    for (const source of sources) {
      expect(rewrite(source)).toBe(fullPasses(source));
    }
    expect(rewrite("[a`]`](./spec.pdf)")).toBe(`[a\`]\`](${served})`);
  });
});

describe("contentAssetParam", () => {
  it("uses the project-relative path inside the root", () => {
    expect(contentAssetParam(root, join(root, "docs", "photo.png"))).toBe(
      "docs/photo.png"
    );
  });

  it("falls back to a content-addressed name outside the root", () => {
    const param = contentAssetParam(root, "/elsewhere/photo.png");
    expect(param).toMatch(/^_\/[a-z0-9]+\.png$/u);
  });
});

describe("collectContentAssets", () => {
  it("maps every referenced asset across routes, skipping unreadable ones", async () => {
    const page2 = join(root, "docs", "images", "gallery.md");
    await writeFile(page2, "![n](./nested.png)");
    await writeFile(pagePath, "![p](./photo.png)\n![m](./missing.png)");
    const files = await collectContentAssets({
      context: { root },
      graph: { pages: [] },
      manifest: {
        routes: [
          { id: "p1", sourcePath: pagePath },
          { id: "p2", sourcePath: page2 },
          { id: "p3", sourcePath: join(root, "docs", "gone.md") },
          { id: "p4" },
        ],
      },
    });
    expect(files).toEqual({
      "docs/images/nested.png": join(root, "docs", "images", "nested.png"),
      "docs/photo.png": join(root, "docs", "photo.png"),
    });
  });
});
