import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";

export default defineConfig({
  // Tests run on Bun's `bun:test` runner (Jest-compatible API), so the Vitest
  // lint preset is intentionally not extended — its
  // `prefer-importing-vitest-globals` rule misreads `bun:test` imports.
  // anti-slop last: it disables the two core rules it fix/break-loops with
  // (consistent-indexed-object-style, no-immediate-mutation).
  extends: [core, react, antiSlop],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    // oxlint misparses single-file `.astro` syntax (template + frontmatter).
    // Nothing else gates the package's components either: `tsgo` never sees
    // `.astro`, and the docs app's `blume check` only reaches its own files.
    // Review `<script>` blocks by hand — a bare identifier there ships.
    "**/*.astro",
    // Blume's generated runtime is an implementation detail.
    "**/.blume",
    // Vendored agent-skill assets (e.g. remotion-best-practices example code)
    // are upstream content, not project source; linting them just diverges from
    // upstream and gets clobbered on the next skill update.
    "**/.agents/skills/**",
    "**/.claude/skills/**",
    // Docs code-sample source shown verbatim in a before/after diff; the
    // PascalCase `Button` export IS the example, so naming rules don't apply.
    "apps/docs/diffs",
    "packages/video/src/components",
    "packages/video/src/lib/utils.ts",
    "packages/video/src/lib/remocn-ui",
    "packages/blume/CHANGELOG.md",
  ],
});
