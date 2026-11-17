import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { dirname, join } from "pathe";

import {
  catchAllPageTemplate,
  ogEndpointTemplate,
} from "../src/astro/templates.ts";
import { cardCacheKey } from "../src/og/cache.ts";
import { cachedOgImage, renderOgImage } from "../src/og/card.ts";
import type { OgCardOptions } from "../src/og/card.ts";
import { eject } from "../src/registry/eject.ts";

/**
 * A blog post's OG card — its authors and date under the headline, its cover
 * in a column beside it — the cache key that follows the cover's bytes, the
 * endpoint that renders the blog's cards, and eject's copy of them.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-blog-cards-"));
  dirs.push(dir);
  return dir;
};

const write = async (root: string, files: Record<string, string | Buffer>) => {
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
};

// A 2x1 PNG: a cover wider than it is tall, cropped to fill its column.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4zwAE/wEHAAH/4iOeWQAAAABJRU5ErkJggg==",
  "base64"
);
const DATA_URI = `data:image/png;base64,${PNG.toString("base64")}`;

const size = (png: Uint8Array): [number, number] => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};

const BASE: OgCardOptions = { brand: "Acme", title: "Webhooks are here" };

describe("a blog post's OG card", () => {
  it("adds the byline, and the cover from a file or a data URI", async () => {
    const dir = await tempDir();
    const cover = join(dir, "cover.png");
    await writeFile(cover, PNG);
    const plain = await renderOgImage(BASE);
    const byline = await renderOgImage({
      ...BASE,
      article: { authors: ["Ada", "Grace"], date: "May 1, 2026" },
    });
    const fromFile = await renderOgImage({
      ...BASE,
      article: { authors: ["Ada"], cover, date: "May 1, 2026" },
      description: "A description long enough to need the shorter limit.",
    });
    const fromUri = await renderOgImage({
      ...BASE,
      article: { cover: DATA_URI },
    });
    for (const png of [byline, fromFile, fromUri]) {
      expect(size(png)).toEqual([1200, 630]);
      expect(Buffer.from(png).equals(Buffer.from(plain))).toBe(false);
    }
    expect(Buffer.from(fromFile).equals(Buffer.from(byline))).toBe(false);
  });

  it("renders without a cover it can't read or decode", async () => {
    const dir = await tempDir();
    const corrupt = join(dir, "corrupt.png");
    // A PNG whose image data fails its checksum.
    await writeFile(
      corrupt,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAJ/wH/WqKu4QAAAABJRU5ErkJggg==",
        "base64"
      )
    );
    const missing = await renderOgImage({
      ...BASE,
      article: { cover: "/nowhere/cover.png" },
    });
    const undecodable = await renderOgImage({
      ...BASE,
      article: { cover: corrupt },
    });
    // An empty article changes nothing about the card.
    const empty = await renderOgImage({ ...BASE, article: {} });
    const plain = Buffer.from(await renderOgImage(BASE));
    expect(Buffer.from(missing).equals(plain)).toBe(true);
    expect(Buffer.from(undecodable).equals(plain)).toBe(true);
    expect(Buffer.from(empty).equals(plain)).toBe(true);
  });

  it("never caches a card whose cover it couldn't read", async () => {
    // The key reads the cover before the card does: a file that stops reading
    // in between must not leave a cover-less card under the cover's bytes.
    const cache = { dir: join(await tempDir(), "og"), version: "1.0.0" };
    await cachedOgImage(cache, {
      ...BASE,
      article: { cover: "/nowhere/cover.png" },
    });
    expect(existsSync(cache.dir)).toBe(false);
    await cachedOgImage(cache, BASE);
    expect(readdirSync(cache.dir)).toHaveLength(1);
  });

  it("keys the card cache by a local cover's bytes", async () => {
    const dir = await tempDir();
    const cover = join(dir, "cover.png");
    await writeFile(cover, PNG);
    const options: OgCardOptions = { ...BASE, article: { cover } };
    const first = await cardCacheKey("1.0.0", options);
    await writeFile(cover, Buffer.concat([PNG, Buffer.from([0])]));
    // The digest is per path per process for fonts, but a cover is read
    // afresh: a redrawn cover must re-render the card.
    expect(await cardCacheKey("1.0.0", options)).not.toBe(first);
    // A missing file keys as missing, and a URL by the URL itself.
    const missing: OgCardOptions = {
      ...BASE,
      article: { cover: join(dir, "nope.png") },
    };
    expect(await cardCacheKey("1.0.0", missing)).toBe(
      await cardCacheKey("1.0.0", missing)
    );
    const url = await cardCacheKey("1.0.0", {
      ...BASE,
      article: { cover: "https://img.test/a.png" },
    });
    expect(url).not.toBe(
      await cardCacheKey("1.0.0", {
        ...BASE,
        article: { cover: "https://img.test/b.png" },
      })
    );
    // A card with no article keys as it always did.
    expect(await cardCacheKey("1.0.0", BASE)).not.toBe(first);
  });
});

describe("the OG endpoint", () => {
  it("adds the blog's cards and each post's article, when the index is generated", () => {
    const endpoint = ogEndpointTemplate([], {}, false, {
      covers: { "/blog/a": "/abs/cover.png" },
      index: true,
      tags: true,
    });
    expect(endpoint).toContain(
      'const covers: Record<string, string> = {"/blog/a":"/abs/cover.png"};'
    );
    expect(endpoint).toContain(
      'add("blog", data.ui.blog?.title ?? "Blog", data.ui.blog?.description ?? null);'
    );
    expect(endpoint).toContain(`\`blog/tags/\${tag.slug}\``);
    expect(endpoint).toContain("postArticle(route)");
    expect(endpoint).toContain(
      "...(props.article ? { article: props.article } : {}),"
    );
    // Without the generated index, no blog cards and no covers.
    const plain = ogEndpointTemplate();
    expect(plain).toContain("const covers: Record<string, string> = {};");
    expect(plain).not.toContain('add("blog"');
  });

  it("frames a blog post in the catch-all page", () => {
    const page = catchAllPageTemplate({
      exportEpub: false,
      exportPdf: false,
      mathEnabled: false,
      needsReact: false,
    });
    expect(page).toContain(
      'import PostMeta from "blume/components/layout/PostMeta.astro";'
    );
    expect(page).toContain(
      "{blogPost && <PostMeta locale={htmlLang} post={blogPost} strings={ui.blog} />}"
    );
    expect(page).toContain("{blogPost && <PostByline post={blogPost} />}");
    // A post typed by `content.defaultType` is a post too.
    expect(page).toContain('pageType={post ? "blog" : frontmatter.type}');
  });
});

/** A component's source, as the Astro build reads it. */
const componentSource = (path: string) =>
  readFileSync(
    fileURLToPath(new URL(`../src/components/${path}`, import.meta.url)),
    "utf-8"
  );

describe("the post components", () => {
  it("leave the date, tags, and byline out of narration, which starts at the title", () => {
    expect(componentSource("layout/PostMeta.astro")).toContain(
      'data-blume-narration="skip"'
    );
    expect(componentSource("layout/PostByline.astro")).toContain(
      'data-blume-narration="skip"'
    );
  });

  it("title a card under its year, or under the page when no post is dated", () => {
    expect(componentSource("content/Blog.astro")).toContain(
      'const CardHeading = groups.some((group) => group.year) ? "h3" : "h2";'
    );
  });
});

describe("eject", () => {
  it("writes the blog's pages, and each cover relative to the project", async () => {
    const root = await tempDir();
    await write(root, {
      "blume.config.ts":
        'export default { deployment: { site: "https://example.com" } };\n',
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ndate: 2026-01-01\ntags: [Go]\ncover: ./cover.png\n---\n\nBody.\n",
      "docs/blog/b.md":
        "---\ntitle: B\ntype: blog\ndate: 2026-01-02\ncover: https://img.test/b.png\n---\n\nBody.\n",
      "docs/blog/cover.png": PNG,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    expect(existsSync(join(root, "src/pages/blog.astro"))).toBe(true);
    expect(existsSync(join(root, "src/pages/blog/tags/[tag].astro"))).toBe(
      true
    );
    const endpoint = readFileSync(
      join(root, "src/pages/og/[...slug].png.ts"),
      "utf-8"
    );
    expect(endpoint).toContain(
      'const covers: Record<string, string> = {"/blog/b":"https://img.test/b.png","/blog/a":"docs/blog/cover.png"};'
    );
    expect(endpoint).toContain('add("blog"');
  });
});
