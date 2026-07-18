import { readFile } from "node:fs/promises";

import { join } from "pathe";

import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { imageSize } from "../image-size.ts";
import type { ImageSize } from "../image-size.ts";
import { pageSite } from "../locate.ts";
import type { CheckModule, PageSnapshot } from "../types.ts";
import { resolveHref, siteOrigin } from "../url.ts";

/**
 * Below this, large social cards render the image blurry or fall back to a
 * small-card layout: Facebook's floor for a full-width card is 600×315
 * (1200×630 recommended), X's for `summary_large_image` is 300×157.
 */
const MIN_WIDTH = 600;
const MIN_HEIGHT = 315;

/**
 * The Open Graph image as bytes, not just a tag. `OG_IMAGE_MISSING` proves the
 * meta tag exists; only the build can prove the tag points at a real file of a
 * shareable size — a crawler needs the live site for either.
 */
export const ogImageChecks: CheckModule = {
  category: "social",
  async run(context) {
    const found: Diagnostic[] = [];
    /** Pending reads per file path — the site-wide default OG image is read once. */
    const sizes = new Map<string, Promise<ImageSize | null>>();

    const read = async (path: string): Promise<ImageSize | null> => {
      try {
        return imageSize(await readFile(join(context.staticDir, path)));
      } catch {
        // Unreadable bytes: existence was already established via the file
        // index, and an unknown format is not a finding.
        return null;
      }
    };

    // Cache the promise, not the result, so concurrent pages sharing one
    // image (the site-wide default) share a single read.
    const measure = (path: string): Promise<ImageSize | null> => {
      const cached = sizes.get(path);
      if (cached) {
        return cached;
      }
      const pending = read(path);
      sizes.set(path, pending);
      return pending;
    };

    const origin = siteOrigin(context.project.config.deployment.site);
    const candidates: { page: PageSnapshot; path: string }[] = [];

    for (const page of context.pages) {
      const src = page.og["og:image"];
      if (!src) {
        continue;
      }
      // An og:image on another origin (a CDN, an external host) is outside the
      // build — its existence can't be proven without the network, so it's the
      // network tier's business, not this check's.
      const resolved = resolveHref(page.url, src, origin);
      if (resolved.kind === "external" || resolved.kind === "ignored") {
        continue;
      }

      const { path } = resolved;
      if (
        !(context.files.has(path) || context.files.has(`${path}/index.html`))
      ) {
        found.push(
          finding(
            "BLUME_AUDIT_OG_IMAGE_BROKEN",
            pageSite(context, page, ["seo", "image"]),
            `og:image points at ${path}, which is not in the build.`
          )
        );
        continue;
      }

      candidates.push({ page, path });
    }

    const measured = await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        size: await measure(candidate.path),
      }))
    );
    for (const { page, path, size } of measured) {
      if (size && (size.width < MIN_WIDTH || size.height < MIN_HEIGHT)) {
        found.push(
          finding(
            "BLUME_AUDIT_OG_IMAGE_SMALL",
            pageSite(context, page, ["seo", "image"]),
            `og:image ${path} is ${size.width}×${size.height} — below the ${MIN_WIDTH}×${MIN_HEIGHT} floor for large social cards.`
          )
        );
      }
    }

    return found;
  },
  tier: "static",
};
