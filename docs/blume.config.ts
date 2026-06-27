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
  navigation: {
    tabs: [
      { label: "Home", path: "/" },
      { label: "Docs", path: "/docs" },
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
