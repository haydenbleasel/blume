import { defineConfig } from "blume";

export default defineConfig({
  ai: {
    llmsTxt: true,
  },
  banner: {
    content: "Blume is in beta — expect breaking changes.",
    dismissible: true,
    id: "beta",
  },
  content: {
    root: "content",
  },
  deployment: {
    site: "https://blume.dev",
  },
  description:
    "Open-source, markdown-first documentation powered by Astro and Vite.",
  github: {
    dir: "docs",
    owner: "haydenbleasel",
    repo: "blume",
  },
  logo: "/logo.svg",
  markdown: {
    math: true,
  },
  theme: {
    accent: "teal",
  },
  title: "Blume",
});
