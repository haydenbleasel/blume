import { defineConfig } from "blume";

export default defineConfig({
  ai: {
    ask: {
      enabled: true,
      suggestions: [
        { icon: "rocket", label: "What is Blume?" },
        { icon: "file-text", label: "How do I write a docs page?" },
        { icon: "settings", label: "How do I configure the theme?" },
        { icon: "sparkles", label: "How does Ask AI work?" },
      ],
    },
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
  // Ask AI and the MCP server need on-demand rendering, so the site deploys as
  // a Vercel server function rather than a static export.
  deployment: {
    adapter: "vercel",
    output: "server",
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
  mcp: {
    enabled: true,
  },
  navigation: {
    tabs: [
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
