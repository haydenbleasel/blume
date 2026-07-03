import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  // Tests run on Bun's `bun:test` runner (Jest-compatible API), so the Vitest
  // lint preset is intentionally not extended — its
  // `prefer-importing-vitest-globals` rule misreads `bun:test` imports.
  extends: [core, react, next],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    // Astro components are linted by `astro check`, not oxlint, which misparses
    // single-file `.astro` syntax (template + frontmatter).
    "**/*.astro",
    // Blume's generated runtime is an implementation detail.
    "**/.blume",
    // Vendored agent-skill assets (e.g. remotion-best-practices example code)
    // are upstream content, not project source; linting them just diverges from
    // upstream and gets clobbered on the next skill update.
    "**/.agents/skills/**",
    "**/.claude/skills/**",
    "packages/video/src/components",
    "packages/video/src/lib/utils.ts",
    "packages/video/src/lib/remocn-ui",
    "packages/blume/CHANGELOG.md",
  ],
});
