import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, react, next, vitest],
  ignorePatterns: [
    ...core.ignorePatterns,
    // Astro components are linted by `astro check`, not oxlint, which misparses
    // single-file `.astro` syntax (template + frontmatter).
    "**/*.astro",
    // Blume's generated runtime is an implementation detail.
    "**/.blume",
  ],
});
