import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";
import { filesystem, githubReleases } from "blume/sources";

export default defineConfig({
  agents: {
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
        "Reach for Blume when a project needs a documentation site from Markdown or MDX with no app code to maintain: product docs, API references (OpenAPI, AsyncAPI, GraphQL), changelogs, blogs, and multi-language or versioned docs. Drop files in a `docs/` folder and run the `blume` CLI — it generates and drives the Astro site, search, OG images, and the agent-facing surface (llms.txt and Markdown mirrors by default, plus an opt-in MCP server and published agent skills) for you.",
        "",
        "Scaffold a site with `npx blume init` (package: https://www.npmjs.com/package/blume), which installs dependencies and adds scripts: `npm run dev` to preview and `npm run build` to ship. Every other command runs through the package runner, like `npx blume eject` to turn the hidden project into a standalone Astro app. The `blume` agent skill below covers configuration and authoring; `npx blume migrate <source> --codex` (or `--claude`) hands an existing Mintlify, Fumadocs, Docusaurus, Starlight, or Nextra site to a coding agent with the `blume-migrate` skill.",
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
  // Server output (MCP server) on Cloudflare Workers via @astrojs/cloudflare.
  // The adapter reads wrangler.jsonc at this directory's root and emits the
  // deployable config to dist/server/wrangler.json, which the `deploy` script
  // hands to wrangler. Workers Builds doesn't expose a site URL the way Pages
  // does, so the canonical origin is pinned here.
  deployment: cloudflare({ site: "https://useblume.dev" }),
  description:
    "The open-source docs framework for humans and agents. Drop Markdown into a folder and ship a fast, searchable docs site.",
  export: true,
  // Docs pages only: the landing, CLI, and Agents pages pass their own
  // footer (pages/_home/Footer.astro), which takes its place.
  footer: {
    links: [
      {
        href: "/changelog",
        label: {
          de: "Änderungen",
          en: "Changelog",
          hi: "चेंजलॉग",
          ja: "変更履歴",
          pt: "Alterações",
        },
      },
      { href: "https://www.npmjs.com/package/blume", label: "npm" },
      {
        href: "https://github.com/sponsors/haydenbleasel",
        label: {
          de: "Sponsern",
          en: "Sponsor",
          hi: "प्रायोजक बनें",
          ja: "スポンサー",
          pt: "Patrocinar",
        },
      },
      {
        href: "https://github.com/haydenbleasel/blume/issues",
        label: {
          de: "Problem melden",
          en: "Report an issue",
          hi: "समस्या बताएं",
          ja: "問題を報告",
          pt: "Reportar um problema",
        },
      },
      {
        href: "https://github.com/haydenbleasel/blume/blob/main/LICENSE",
        label: {
          de: "MIT-Lizenz",
          en: "MIT License",
          hi: "MIT लाइसेंस",
          ja: "MIT ライセンス",
          pt: "Licença MIT",
        },
      },
    ],
    // The repository link comes first on its own, from `github`.
    socials: { x: "https://x.com/haydenbleasel" },
  },
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
    ui: {
      en: {
        changelog: {
          description:
            "Every Blume release, newest first: new features, fixes, and breaking changes, straight from the release notes on GitHub.",
        },
      },
    },
  },
  lastModified: "git",
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
      { label: "Agents", path: "/agents" },
      { label: "Compare", path: "/compare" },
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
    { from: "/docs/reference/frontmatter", to: "/docs/content/frontmatter" },
    {
      from: "/de/docs/reference/frontmatter",
      to: "/de/docs/content/frontmatter",
    },
    {
      from: "/hi/docs/reference/frontmatter",
      to: "/hi/docs/content/frontmatter",
    },
    {
      from: "/ja/docs/reference/frontmatter",
      to: "/ja/docs/content/frontmatter",
    },
    {
      from: "/pt/docs/reference/frontmatter",
      to: "/pt/docs/content/frontmatter",
    },
    { from: "/docs/reference/cli", to: "/docs/cli" },
    { from: "/docs/reference/eval", to: "/docs/cli/evals" },
    { from: "/docs/reference/translate", to: "/docs/cli/translate" },
    { from: "/docs/reference/audit", to: "/docs/cli/audit" },
    { from: "/de/docs/reference/cli", to: "/de/docs/cli" },
    { from: "/de/docs/reference/eval", to: "/de/docs/cli/evals" },
    { from: "/de/docs/reference/translate", to: "/de/docs/cli/translate" },
    { from: "/de/docs/reference/audit", to: "/de/docs/cli/audit" },
    { from: "/hi/docs/reference/cli", to: "/hi/docs/cli" },
    { from: "/hi/docs/reference/eval", to: "/hi/docs/cli/evals" },
    { from: "/hi/docs/reference/translate", to: "/hi/docs/cli/translate" },
    { from: "/hi/docs/reference/audit", to: "/hi/docs/cli/audit" },
    { from: "/ja/docs/reference/cli", to: "/ja/docs/cli" },
    { from: "/ja/docs/reference/eval", to: "/ja/docs/cli/evals" },
    { from: "/ja/docs/reference/translate", to: "/ja/docs/cli/translate" },
    { from: "/ja/docs/reference/audit", to: "/ja/docs/cli/audit" },
    { from: "/pt/docs/reference/cli", to: "/pt/docs/cli" },
    { from: "/pt/docs/reference/eval", to: "/pt/docs/cli/evals" },
    { from: "/pt/docs/reference/translate", to: "/pt/docs/cli/translate" },
    { from: "/pt/docs/reference/audit", to: "/pt/docs/cli/audit" },
    { from: "/docs/advanced/api-reference", to: "/docs/references/openapi" },
    { from: "/docs/advanced/graphql", to: "/docs/references/graphql" },
    {
      from: "/de/docs/advanced/api-reference",
      to: "/de/docs/references/openapi",
    },
    { from: "/de/docs/advanced/graphql", to: "/de/docs/references/graphql" },
    {
      from: "/hi/docs/advanced/api-reference",
      to: "/hi/docs/references/openapi",
    },
    { from: "/hi/docs/advanced/graphql", to: "/hi/docs/references/graphql" },
    {
      from: "/ja/docs/advanced/api-reference",
      to: "/ja/docs/references/openapi",
    },
    { from: "/ja/docs/advanced/graphql", to: "/ja/docs/references/graphql" },
    {
      from: "/pt/docs/advanced/api-reference",
      to: "/pt/docs/references/openapi",
    },
    { from: "/pt/docs/advanced/graphql", to: "/pt/docs/references/graphql" },
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
    {
      from: "/docs/configuration/ask-ai",
      to: "/docs/configuration/assistant",
    },
    {
      from: "/de/docs/configuration/ask-ai",
      to: "/de/docs/configuration/assistant",
    },
    {
      from: "/hi/docs/configuration/ask-ai",
      to: "/hi/docs/configuration/assistant",
    },
    {
      from: "/ja/docs/configuration/ask-ai",
      to: "/ja/docs/configuration/assistant",
    },
    {
      from: "/pt/docs/configuration/ask-ai",
      to: "/pt/docs/configuration/assistant",
    },
  ],
  seo: {
    og: {
      titles: {
        "/cli": "CLI",
        "/compare/docusaurus": "Blume vs Docusaurus",
        "/compare/fumadocs": "Blume vs Fumadocs",
        "/compare/mintlify": "Blume vs Mintlify",
        "/compare/nextra": "Blume vs Nextra",
        "/compare/starlight": "Blume vs Starlight",
      },
    },
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
      operatingSystem: "Node.js 22.12+",
      price: 0,
      sameAs: [
        "https://www.npmjs.com/package/blume",
        "https://github.com/haydenbleasel/blume",
      ],
    },
    x: { creator: "@haydenbleasel", handle: "@haydenbleasel" },
  },
  theme: {
    // Cornflower, step 4 of the marketing pages' bloom ramp
    // (pages/_home/bloom.css); a step lighter in dark mode so links keep
    // their contrast on the dark background.
    accent: {
      dark: "oklch(0.62 0.13 266)",
      light: "oklch(0.54 0.14 266)",
    },
  },
  title: "Blume",
});
