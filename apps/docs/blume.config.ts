import { defineConfig } from "blume";

export default defineConfig({
  content: {
    exclude: ["node_modules/**", ".blume/**", "dist/**", "bun.lock"],
    include: [
      "*.mdx",
      "concepts/**/*.mdx",
      "guides/**/*.mdx",
      "migration/**/*.mdx",
      "reference/**/*.mdx",
    ],
    root: ".",
  },
  description: "Markdown-first documentation powered by Astro and Vite.",
  title: "Blume",
});
