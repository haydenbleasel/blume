import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    // The plan is the working spec; keep it pristine and out of the formatter.
    "plan",
    "**/.blume",
  ],
});
