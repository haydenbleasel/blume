import { defineConfig } from "blume";

export default defineConfig({
  ai: {
    llmsTxt: true,
  },
  analytics: {
    vercel: true,
  },
  banner: {
    content: "Blume is now publicly available.",
    dismissible: true,
    id: "beta",
  },
  content: {
    root: "content",
    sources: [
      // Local docs under content/
      { root: "content", type: "filesystem" },
      // The changelog is sourced from this repo's GitHub releases. Private repo,
      // so the API token is read from GITHUB_TOKEN (.env.local / .env).
      {
        owner: "haydenbleasel",
        prefix: "changelog",
        repo: "blume",
        type: "github-releases",
      },
    ],
  },
  deployment: {
    site: "https://blume.dev",
  },
  description:
    "Open-source, markdown-first documentation powered by Astro and Vite.",
  export: true,
  github: {
    dir: "apps/docs",
    owner: "haydenbleasel",
    repo: "blume",
  },
  lastModified: true,
  logo: "/logo.svg",
  markdown: {
    code: {
      inline: true,
    },
    math: true,
  },
  navigation: {
    tabs: [
      { label: "Home", path: "/" },
      { label: "Docs", path: "/docs" },
      { label: "Changelog", path: "/changelog" },
    ],
  },
  // The "Example API" navbar tab is added automatically from this reference.
  openapi: {
    enabled: true,
    route: "/api",
    sources: [
      {
        label: "Example API",
        spec: "https://petstore3.swagger.io/api/v3/openapi.json",
      },
    ],
  },
  theme: {
    accent: "teal",
  },
  title: "Blume",
});
