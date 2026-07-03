import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "**/.blume",
    "packages/video/src/components",
    "packages/video/src/lib/utils.ts",
    "packages/video/src/lib/remocn-ui",
    "packages/blume/CHANGELOG.md",
  ],
});
