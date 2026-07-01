// Copies the docs site content (apps/docs/content/docs) into the package as
// docs/ so it ships in the published tarball and resolves at
// node_modules/blume/docs. Generated output is gitignored; this runs on
// `prepare` (after install) and `prepack` (before publish) to keep the bundled
// copy fresh. The docs site under apps/docs/content/docs remains the single
// source of truth.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const src = path.join(
  here,
  "..",
  "..",
  "..",
  "apps",
  "docs",
  "content",
  "docs"
);
const dest = path.join(here, "..", "docs");

if (existsSync(src)) {
  rmSync(dest, { force: true, recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[bundle-docs] copied ${src} -> ${dest}`);
} else {
  // Not a fatal error: a consumer installing the published package already has
  // docs/ in the tarball and has no source tree to copy from. Skip quietly.
  console.warn(`[bundle-docs] source not found, skipping: ${src}`);
}
