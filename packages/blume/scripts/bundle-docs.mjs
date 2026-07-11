// Copies bundled assets into the package so they ship in the published tarball
// and resolve under node_modules/blume: the docs site content
// (apps/docs/content/docs -> docs/), the agent skills (repo-root skills/ ->
// skills/), and the repo-root README.md and LICENSE. All generated copies are
// gitignored; this runs on the repo root's `prepare` (after install in the
// monorepo) and this package's `prepack` (before publish) to keep them fresh.
// The originals (apps/docs/content/docs, the repo-root skills/, README.md,
// and LICENSE) remain the source of truth.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const repoRoot = path.join(here, "..", "..", "..");

/** Mirror a source file or directory into the package, replacing any prior copy. */
const bundle = (from, to) => {
  if (existsSync(from)) {
    rmSync(to, { force: true, recursive: true });
    cpSync(from, to, { recursive: true });
    console.log(`[bundle-docs] copied ${from} -> ${to}`);
  } else {
    // Not a fatal error: a consumer installing the published package already has
    // the bundled copy in the tarball and has no source tree to copy from.
    console.warn(`[bundle-docs] source not found, skipping: ${from}`);
  }
};

bundle(
  path.join(repoRoot, "apps", "docs", "content", "docs"),
  path.join(here, "..", "docs")
);
bundle(path.join(repoRoot, "skills"), path.join(here, "..", "skills"));
bundle(path.join(repoRoot, "README.md"), path.join(here, "..", "README.md"));
bundle(path.join(repoRoot, "LICENSE"), path.join(here, "..", "LICENSE"));
