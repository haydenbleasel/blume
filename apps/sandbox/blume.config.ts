import { defineConfig } from "blume";
import { node } from "blume/deploy";
import { asyncapi, graphql, openapi } from "blume/reference";
import { filesystem, githubReleases } from "blume/sources";
import { z } from "zod";

/**
 * Kitchen-sink sandbox: every Blume feature enabled in one project, for
 * exercising the framework end to end — including the native OpenAPI and
 * AsyncAPI renderers, search, Ask AI, MCP, i18n, export, and OG images.
 */
export default defineConfig({
  agents: {
    mcp: { enabled: true },
    skills: "../../skills",
  },
  ai: {
    ask: {
      enabled: true,
      suggestions: [
        { icon: "rocket", label: "How do I get started?" },
        { icon: "radio", label: "What events does the API publish?" },
        { icon: "blocks", label: "Which components can I use?" },
      ],
    },
  },
  banner: {
    content: "This is the Blume kitchen-sink sandbox.",
    dismissible: true,
    id: "sandbox",
    link: { href: "/events", text: "Try the AsyncAPI reference" },
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
    types: {
      doc: { facets: ["owner"] },
    },
  },
  deployment: node({ site: "https://sandbox.useblume.dev" }),
  description: "Every Blume feature, enabled in one place.",
  export: true,
  feedback: true,
  frontmatter: {
    extend: {
      owner: z.string().optional(),
    },
  },
  github: {
    dir: "apps/sandbox",
    owner: "haydenbleasel",
    repo: "blume",
  },
  i18n: {
    defaultLocale: "en",
    fallbackLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "de", label: "Deutsch", style: "Informal du-form" },
    ],
  },
  lastModified: "git",
  logo: "/logo.svg",
  markdown: {
    code: { icons: true, wrap: true },
  },
  navigation: {
    featured: [
      {
        href: "https://github.com/haydenbleasel/blume",
        icon: "github",
        label: "GitHub",
      },
    ],
    tabs: [
      { label: "Docs", path: "/docs" },
      { label: "API", path: "/api" },
      { label: "GraphQL", path: "/graphql" },
      { label: "Events", path: "/events" },
      { label: "Blog", path: "/blog" },
      { label: "Changelog", path: "/changelog" },
    ],
  },
  redirects: [{ from: "/start", to: "/docs" }],
  reference: [
    openapi({
      expandSchemas: true,
      route: "/api",
      spec: "./specs/openapi.yaml",
    }),
    asyncapi({
      sources: [{ label: "Commerce events", spec: "./specs/asyncapi.yaml" }],
    }),
    graphql({
      endpoint: "https://petstore.example.com/graphql",
      spec: "./specs/schema.graphql",
    }),
  ],
  search: {
    popular: [
      { href: "/docs", icon: "rocket", label: "Getting started" },
      { href: "/events", icon: "radio", label: "Event reference" },
      { href: "/api", icon: "braces", label: "API reference" },
    ],
  },
  seo: {
    x: { creator: "@haydenbleasel", handle: "@haydenbleasel" },
  },
  theme: {
    accent: "purple",
    radius: "lg",
  },
  title: "Blume Sandbox",
  versions: {
    archived: [{ id: "v1.0" }],
    current: { badge: "Latest", label: "v2.0" },
  },
});
