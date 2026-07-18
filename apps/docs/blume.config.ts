import { defineConfig } from "blume";

export default defineConfig({
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
      { root: "content", type: "filesystem" },
      {
        owner: "haydenbleasel",
        prefix: "changelog",
        repo: "blume",
        type: "github-releases",
      },
    ],
  },
  deployment: {
    adapter: "vercel",
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
  navigation: {
    tabs: [
      { label: "Docs", path: "/docs" },
      { label: "CLI", path: "/cli" },
      { label: "Changelog", path: "/changelog" },
    ],
  },
  seo: {
    x: { creator: "@haydenbleasel", handle: "@haydenbleasel" },
  },
  theme: {
    accent: "teal",
  },
  title: "Blume",
});
