import { defineConfig } from "blume";

export default defineConfig({
  ai: {
    mcp: {
      enabled: true,
    },
    skills: "../../skills",
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
  i18n: {
    defaultLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "de", label: "Deutsch" },
      { code: "hi", label: "हिन्दी" },
      { code: "ja", label: "日本語" },
      { code: "pt", label: "Português" },
    ],
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
    og: { titles: { "/cli": "CLI" } },
    x: { creator: "@haydenbleasel", handle: "@haydenbleasel" },
  },
  theme: {
    accent: "teal",
  },
  title: "Blume",
});
