import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { ogImageChecks } from "../src/audit/checks/og-image.ts";
import { imageSize } from "../src/audit/image-size.ts";
import type { Diagnostic } from "../src/core/types.ts";
import { codes, context, snapshot } from "./audit-support.ts";

/** The og:image byte checks, and the header-only dimension parser under them. */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** A syntactically minimal PNG: signature + IHDR carrying the dimensions. */
const png = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

/**
 * SOI, an APP0 segment to walk over, then SOF0 with the dimensions: the
 * segment layout is FF E0 (APP0) + u16 length, then FF C0 (SOF0) + u16
 * length + u8 precision + u16 height + u16 width.
 */
const jpeg = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(2 + 6 + 11);
  bytes.writeUInt16BE(0xff_d8, 0);
  bytes.writeUInt16BE(0xff_e0, 2);
  bytes.writeUInt16BE(4, 4);
  bytes.writeUInt16BE(0xff_c0, 8);
  bytes.writeUInt16BE(9, 10);
  bytes.writeUInt8(8, 12);
  bytes.writeUInt16BE(height, 13);
  bytes.writeUInt16BE(width, 15);
  return bytes;
};

const gif = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
};

describe("imageSize", () => {
  it("reads PNG, JPEG, and GIF headers", () => {
    expect(imageSize(png(1200, 630))).toEqual({ height: 630, width: 1200 });
    expect(imageSize(jpeg(800, 400))).toEqual({ height: 400, width: 800 });
    expect(imageSize(gif(120, 60))).toEqual({ height: 60, width: 120 });
  });

  it("returns null for unknown formats and truncated files", () => {
    expect(imageSize(Buffer.from("<svg></svg>"))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
    expect(imageSize(png(1, 1).subarray(0, 10))).toBeNull();
    // A JPEG whose segment walk runs off a corrupt marker.
    const corrupt = jpeg(10, 10);
    corrupt.writeUInt8(0x00, 8);
    expect(imageSize(corrupt)).toBeNull();
    // A JPEG that ends before any start-of-frame segment appears.
    expect(imageSize(jpeg(10, 10).subarray(0, 8))).toBeNull();
  });
});

const staticDir = async (files: Record<string, Buffer>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-og-"));
  dirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, bytes]) =>
      writeFile(join(dir, name), bytes)
    )
  );
  return dir;
};

const SITE = "https://x.dev";

const withOg = (image: string) =>
  snapshot({
    og: {
      "og:description": "d",
      "og:image": image,
      "og:title": "t",
      "og:type": "website",
      "og:url": "https://x.dev/",
    },
  });

const run = async (
  ctx: ReturnType<typeof context>,
  dir: string,
  files: Map<string, number>
): Promise<string[]> => {
  ctx.staticDir = dir;
  ctx.files = files;
  return codes((await ogImageChecks.run(ctx)) as Diagnostic[]);
};

describe("ogImageChecks", () => {
  it("is silent on an og:image that exists at a shareable size", async () => {
    const dir = await staticDir({ "og.png": png(1200, 630) });
    const ctx = context({ pages: [withOg(`${SITE}/og.png`)], site: SITE });
    expect(await run(ctx, dir, new Map([["/og.png", 24]]))).toEqual([]);
  });

  it("reports an og:image the build does not contain", async () => {
    const dir = await staticDir({});
    const ctx = context({ pages: [withOg(`${SITE}/gone.png`)], site: SITE });
    expect(await run(ctx, dir, new Map())).toContain("OG_IMAGE_BROKEN");
  });

  it("reports an og:image below the large-card floor", async () => {
    const dir = await staticDir({ "og.png": png(400, 200) });
    const ctx = context({ pages: [withOg(`${SITE}/og.png`)], site: SITE });
    expect(await run(ctx, dir, new Map([["/og.png", 24]]))).toContain(
      "OG_IMAGE_SMALL"
    );
  });

  it("reads a shared og:image once across pages", async () => {
    const dir = await staticDir({ "og.png": png(400, 200) });
    const ctx = context({
      pages: [
        withOg(`${SITE}/og.png`),
        { ...withOg(`${SITE}/og.png`), url: "/b" },
      ],
      site: SITE,
    });
    const found = await run(ctx, dir, new Map([["/og.png", 24]]));
    expect(found.filter((code) => code === "OG_IMAGE_SMALL")).toHaveLength(2);
  });

  it("skips external images, unknown formats, and pages with no og:image", async () => {
    const dir = await staticDir({ "og.svg": Buffer.from("<svg/>") });
    const ctx = context({
      pages: [
        withOg("https://cdn.example.com/og.png"),
        withOg(`${SITE}/og.svg`),
        snapshot({ og: {}, url: "/plain" }),
      ],
      site: SITE,
    });
    expect(await run(ctx, dir, new Map([["/og.svg", 6]]))).toEqual([]);
  });
});
