import { defineConfig } from "blume";

export default defineConfig({
  ai: {
    llmsTxt: {
      details: [
        "## When to use Blume",
        "",
        "Reach for Blume when a project needs a documentation site from Markdown or MDX with no app code to maintain: product docs, API references (OpenAPI, AsyncAPI, GraphQL), changelogs, blogs, and multi-language or versioned docs. Drop files in a `content/` folder and run the `blume` CLI — it generates and drives the Astro site, search, OG images, and the agent-facing surface (llms.txt, Markdown mirrors, an MCP server, agent skills) for you.",
        "",
        "Install the CLI from npm (`npm install blume`, package: https://www.npmjs.com/package/blume), then `blume init` to scaffold, `blume dev` to preview, `blume build` to ship, and `blume eject` to turn the hidden project into a standalone Astro app. The `blume` agent skill below covers configuration and authoring; `blume-migrate` ports an existing Mintlify, Docusaurus, Fumadocs, Nextra, or Starlight site.",
      ].join("\n"),
    },
    mcp: {
      enabled: true,
    },
    skills: "../../skills",
  },
  analytics: {
    vercel: true,
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
      { code: "de", label: "Deutsch", style: "Informal du-form" },
      { code: "hi", label: "हिन्दी", style: "Formal आप-form" },
      { code: "ja", label: "日本語", style: "Polite です/ます form" },
      {
        code: "pt",
        label: "Português",
        style: "Brazilian Portuguese, informal você",
      },
    ],
  },
  lastModified: true,
  logo: "/logo.svg",
  navigation: {
    tabs: [
      {
        label: {
          de: "Doku",
          en: "Docs",
          hi: "दस्तावेज़",
          ja: "ドキュメント",
          pt: "Documentação",
        },
        path: "/docs",
      },
      { label: "CLI", path: "/cli" },
      {
        label: {
          de: "Änderungen",
          en: "Changelog",
          hi: "चेंजलॉग",
          ja: "変更履歴",
          pt: "Alterações",
        },
        path: "/changelog",
      },
    ],
  },
  seo: {
    og: { titles: { "/cli": "CLI" } },
    organization: {
      logo: "/logo.svg",
      name: "Blume",
      sameAs: [
        "https://github.com/haydenbleasel/blume",
        "https://www.npmjs.com/package/blume",
        "https://x.com/haydenbleasel",
      ],
    },
    software: {
      license: "https://opensource.org/license/mit",
      operatingSystem: "Node.js 22+",
      price: 0,
      sameAs: [
        "https://www.npmjs.com/package/blume",
        "https://github.com/haydenbleasel/blume",
      ],
    },
    x: { creator: "@haydenbleasel", handle: "@haydenbleasel" },
  },
  theme: {
    accent: "teal",
  },
  title: "Blume",
});
