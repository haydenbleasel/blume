import { defineConfig } from "blume";
import { z } from "zod";

/**
 * Kitchen-sink sandbox: every Blume feature enabled in one project, for
 * exercising the framework end to end — including the native OpenAPI and
 * AsyncAPI renderers, search, Ask AI, MCP, i18n, export, and OG images.
 */
export default defineConfig({
  ai: {
    ask: {
      enabled: true,
      suggestions: [
        { icon: "rocket", label: "How do I get started?" },
        { icon: "radio", label: "What events does the API publish?" },
        { icon: "blocks", label: "Which components can I use?" },
      ],
    },
    mcp: { enabled: true },
    skills: "../../skills",
  },
  asyncapi: {
    enabled: true,
    sources: [{ label: "Commerce events", spec: "./specs/asyncapi.yaml" }],
  },
  banner: {
    content: "This is the Blume kitchen-sink sandbox.",
    dismissible: true,
    id: "sandbox",
    link: { href: "/events", text: "Try the AsyncAPI reference" },
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
    types: {
      doc: { facets: ["owner"] },
    },
  },
  deployment: {
    adapter: "node",
    output: "server",
    site: "https://sandbox.useblume.dev",
  },
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
  lastModified: true,
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
      { label: "Events", path: "/events" },
      { label: "Blog", path: "/blog" },
      { label: "Changelog", path: "/changelog" },
    ],
  },
  openapi: {
    enabled: true,
    expandSchemas: true,
    route: "/api",
    spec: "./specs/openapi.yaml",
  },
  redirects: [{ from: "/start", to: "/docs" }],
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
});
