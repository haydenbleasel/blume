import { defineConfig } from "blume";
import { filesystem, githubReleases } from "blume/sources";

export default defineConfig({
  ai: {
    catalog: {
      queries: {
        "mcp:blume": [
          "how do I configure a Blume docs site",
          "search the Blume documentation",
          "what does blume build generate",
        ],
        "skill:blume": [
          "set up a Blume documentation site",
          "write MDX content for Blume",
          "configure blume.config.ts",
        ],
        "skill:blume-migrate": [
          "migrate my Mintlify docs to Blume",
          "convert a Docusaurus site to Blume",
          "port Starlight docs to Blume",
        ],
        "skill:blume-update-docs": [
          "check the Blume docs for drift after a release",
          "update stale documentation pages",
        ],
      },
    },
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
  content: {
    sources: [
      filesystem({ root: "content" }),
      githubReleases({
        owner: "haydenbleasel",
        prefix: "changelog",
        repo: "blume",
      }),
    ],
  },
  deployment: {
    // Server output (MCP server) on Cloudflare Workers via @astrojs/cloudflare.
    // The adapter reads wrangler.jsonc at this directory's root and emits the
    // deployable config to dist/server/wrangler.json, which the `deploy` script
    // hands to wrangler. Workers Builds doesn't expose a site URL the way Pages
    // does, so the canonical origin is pinned here.
    adapter: "cloudflare",
    output: "server",
    site: "https://useblume.dev",
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
  redirects: [
    { from: "/docs/configuration/ai", to: "/docs/discoverability" },
    { from: "/docs/configuration/seo", to: "/docs/discoverability" },
    { from: "/de/docs/configuration/ai", to: "/de/docs/discoverability" },
    { from: "/de/docs/configuration/seo", to: "/de/docs/discoverability" },
    { from: "/hi/docs/configuration/ai", to: "/hi/docs/discoverability" },
    { from: "/hi/docs/configuration/seo", to: "/hi/docs/discoverability" },
    { from: "/ja/docs/configuration/ai", to: "/ja/docs/discoverability" },
    { from: "/ja/docs/configuration/seo", to: "/ja/docs/discoverability" },
    { from: "/pt/docs/configuration/ai", to: "/pt/docs/discoverability" },
    { from: "/pt/docs/configuration/seo", to: "/pt/docs/discoverability" },
  ],
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
