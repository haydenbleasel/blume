// Guides: long-form walkthroughs that each take a reader to one goal with
// Blume ("Deploy Markdown docs to GitHub Pages"), written for the people
// searching for that task and the answer engines that quote them. An entry
// here is the guide's card (the homepage row, the /guides index, and another
// guide's "keep going" row) and its page's header, facts, and next step; its
// body lives in its own static route under guides/ (so it gets an OG card and
// a sitemap entry, like the customer stories and compare pages). The array's
// order is the display order; the homepage shows the first three.

/** A guide's shelf: the label on its card and page, and a Lucide glyph. */
export const topics = {
  agents: { icon: "bot", label: "Agents" },
  deploy: { icon: "cloud-upload", label: "Hosting" },
  i18n: { icon: "languages", label: "Translation" },
  migrate: { icon: "arrow-right-left", label: "Migrate" },
  quality: { icon: "list-checks", label: "Quality" },
  reference: { icon: "braces", label: "API reference" },
  search: { icon: "search", label: "Search" },
  seo: { icon: "radar", label: "Discoverability" },
  sources: { icon: "database", label: "Content sources" },
  versioning: { icon: "git-branch", label: "Versioning" },
  writing: { icon: "pen-line", label: "Writing" },
} satisfies Record<string, { icon: string; label: string }>;

/**
 * The /guides index's sections, in order, each gathering the guides whose
 * topic it lists. Every topic belongs to exactly one section.
 */
export const sections: { title: string; topics: (keyof typeof topics)[] }[] = [
  { title: "Migrate to Blume", topics: ["migrate"] },
  { title: "API references", topics: ["reference"] },
  { title: "Content sources", topics: ["sources"] },
  { title: "Hosting", topics: ["deploy"] },
  { title: "AI and agents", topics: ["agents"] },
  { title: "Search", topics: ["search"] },
  { title: "SEO and discoverability", topics: ["seo"] },
  {
    title: "Writing and maintenance",
    topics: ["writing", "quality", "versioning", "i18n"],
  },
];

/** Who writes the guides, credited in each one's header. */
export interface Author {
  href: string;
  name: string;
}

export const authors: Record<"hayden", Author> = {
  hayden: { href: "https://x.com/haydenbleasel", name: "Hayden Bleasel" },
};

export interface Guide {
  author: keyof typeof authors;
  /** The Blume docs pages the guide leans on, linked from its page's facts. */
  docs: { href: string; label: string }[];
  /**
   * The guide's runnable example: its source and, where it deploys, the live
   * site. Linked from the facts once they exist.
   */
  example?: { demo?: string; repo?: string };
  id: string;
  /**
   * The cover, in `public/guides/`: a landscape gradient made with
   * `bun run generate-guide-image` (see scripts/generate-guide-image.ts),
   * whose `--use` also writes the grid's thumbnail to
   * `public/guides/thumbs/<id>.webp`. Decorative, so `alt` stays empty unless
   * the image shows something.
   */
  image?: { alt?: string; src: string };
  /** Search result title and description. */
  meta: { description: string; title: string };
  /**
   * The one thing to do after reading: a command to copy (shown in the
   * install box), a link, or both.
   */
  nextStep: {
    body: string;
    command?: string;
    link?: { href: string; label: string };
    title: string;
  };
  /** What the reader needs before starting, one short line each. */
  prerequisites: string[];
  /**
   * First published, as `YYYY-MM-DD`. Not shown on the site: guides land in
   * batches, so their dates would bunch up. Kept for structured data.
   */
  published: string;
  /** What the reader ends up with: the page's lede and the card's body. */
  summary: string;
  /**
   * The last run of the walkthrough, start to finish, on a clean project:
   * the date (`YYYY-MM-DD`, not shown, like `published`) and the Blume
   * version it ran against (shown in the facts). Set it only when the steps
   * were actually run.
   */
  tested?: { date: string; version: string };
  /** The goal, as the reader would put it: the page's h1 and card's title. */
  title: string;
  topic: keyof typeof topics;
  /** Last meaningful revision, as `YYYY-MM-DD`; not shown, like `published`. */
  updated?: string;
}

// Written 2026-09-27 against main ahead of the 2.1 release, from the plan in
// "Search-focused tutorials for Blume". None has been run end to end on a
// clean project yet, so none sets `tested`, and none has its example project.
export const guides: Guide[] = [
  {
    author: "hayden",
    docs: [
      { href: "/docs/migrating", label: "Migrating" },
      { href: "/docs/deployment#redirects", label: "Redirects" },
      { href: "/compare/mintlify", label: "Blume vs Mintlify" },
    ],
    id: "migrate-from-mintlify",
    image: { src: "/guides/migrate-from-mintlify.webp" },
    meta: {
      description:
        "Move your Mintlify docs to Blume with a coding agent: what carries over, what to review, how to keep your URLs, and how to switch your domain over.",
      title: "How to migrate from Mintlify to self-hosted documentation",
    },
    nextStep: {
      body: "Run it at the root of your Mintlify repository, on a clean branch, then work through the review above.",
      command: "npx blume migrate mintlify --claude",
      link: { href: "/docs/migrating", label: "Read the migration reference" },
      title: "Migrate your docs",
    },
    prerequisites: [
      "A Mintlify docs repository",
      "Node.js 22.12 or later",
      "Claude Code or Codex, signed in",
    ],
    published: "2026-09-27",
    summary:
      "Hand your Mintlify repository to a coding agent, review what it changed, keep your URLs working, and deploy a docs site you host yourself.",
    title: "Migrate your docs from Mintlify",
    topic: "migrate",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      { href: "/docs/references/api-pages", label: "API pages" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "openapi-documentation-website",
    image: { src: "/guides/openapi-documentation-website.webp" },
    meta: {
      description:
        "Generate a documentation website from an OpenAPI spec: a page per operation, a Try it playground, code samples, and your own guides beside the reference.",
      title: "How to generate API documentation from an OpenAPI spec",
    },
    nextStep: {
      body: "Start a project, drop your spec beside it, and add the reference to your config.",
      command: "npx blume init",
      link: {
        href: "/docs/references/openapi",
        label: "Read the OpenAPI reference docs",
      },
      title: "Start your API docs",
    },
    prerequisites: [
      "An OpenAPI spec in YAML or JSON (Swagger 2.0 works too)",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Turn an OpenAPI file into a docs site with a page per operation, a request playground, and hand-written guides beside the reference.",
    title: "Generate API docs from an OpenAPI spec",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/sources/notion", label: "Notion source" },
      { href: "/docs/content/sources", label: "Content sources" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "notion-documentation-website",
    image: { src: "/guides/notion-documentation-website.webp" },
    meta: {
      description:
        "Publish a documentation website from a Notion database: connect Notion to Blume, choose what goes live with a Status property, and rebuild when pages change.",
      title: "How to turn a Notion database into a documentation website",
    },
    nextStep: {
      body: "Pick notion when init asks where your content lives, then add your database ID to the config.",
      command: "npx blume init",
      link: {
        href: "/docs/content/sources/notion",
        label: "Read the Notion source docs",
      },
      title: "Publish your Notion docs",
    },
    prerequisites: [
      "A Notion database of pages",
      "Workspace owner access in Notion",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Keep writing in Notion and publish a searchable docs site from a database, with a Status property that decides what goes live.",
    title: "Turn a Notion database into a docs site",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/deployment#subpath-deploys", label: "Subpath deploys" },
      { href: "/docs/cli/validate", label: "blume validate" },
    ],
    id: "markdown-docs-github-pages",
    image: { src: "/guides/markdown-docs-github-pages.webp" },
    meta: {
      description:
        "Deploy Markdown documentation to GitHub Pages with GitHub Actions: a searchable docs site at your project URL that rebuilds on every push.",
      title: "How to deploy Markdown documentation to GitHub Pages",
    },
    nextStep: {
      body: "Run it in your repository to add Blume beside your code, then add the workflow above.",
      command: "npx blume init",
      link: { href: "/docs/deployment", label: "Read the deployment docs" },
      title: "Put your docs on GitHub Pages",
    },
    prerequisites: [
      "A GitHub repository with Markdown docs",
      "Access to the repository's Pages settings",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Turn the Markdown in your repository into a searchable docs site on GitHub Pages that rebuilds every time you push.",
    title: "Deploy Markdown docs to GitHub Pages",
    topic: "deploy",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/discoverability/mcp", label: "MCP server" },
      { href: "/docs/discoverability/llms-txt", label: "llms.txt" },
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
    ],
    id: "mcp-server-for-documentation",
    image: { src: "/guides/mcp-server-for-documentation.webp" },
    meta: {
      description:
        "Add an MCP server to your documentation so coding agents can search and read it: turn it on, deploy it on a server host, and connect Claude Code or Cursor.",
      title: "How to add an MCP server to your documentation",
    },
    nextStep: {
      body: "Turn it on in your config, deploy, and connect your own editor to it.",
      link: {
        href: "/docs/discoverability/mcp",
        label: "Read the MCP server docs",
      },
      title: "Give agents your docs",
    },
    prerequisites: [
      "A Blume docs project",
      "A host that runs server code",
      "An MCP client, like Claude Code or Cursor",
    ],
    published: "2026-09-27",
    summary:
      "Let coding agents search and read your docs from inside the editor, through an MCP server that deploys with your site.",
    title: "Add an MCP server to your docs",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi#overlays", label: "OpenAPI overlays" },
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
    ],
    id: "openapi-overlays-public-docs",
    image: { src: "/guides/openapi-overlays-public-docs.webp" },
    meta: {
      description:
        "Hide internal endpoints from public API documentation with an OpenAPI Overlay: keep the generated spec untouched and strip internal operations on every build.",
      title: "How to remove internal endpoints from public OpenAPI docs",
    },
    nextStep: {
      body: "Add an overlay beside your spec and list it in the reference's config.",
      link: {
        href: "/docs/references/openapi#overlays",
        label: "Read the overlays docs",
      },
      title: "Write your first overlay",
    },
    prerequisites: [
      "A Blume site with an OpenAPI reference",
      "A spec generated from code, or owned by another team",
      "Basic YAML",
    ],
    published: "2026-09-27",
    summary:
      "Publish a public API reference from the spec your code generates, with an overlay that strips internal operations on every build.",
    title: "Remove internal endpoints from public API docs",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/migrating", label: "Migrating" },
      {
        href: "/docs/deployment#mount-the-docs-under-a-path",
        label: "Mount under a path",
      },
      { href: "/docs/content/islands", label: "Interactive islands" },
      { href: "/compare/docusaurus", label: "Blume vs Docusaurus" },
    ],
    id: "migrate-from-docusaurus",
    image: { src: "/guides/migrate-from-docusaurus.webp" },
    meta: {
      description:
        "Move a Docusaurus site's docs to Blume with a coding agent: sidebars, admonitions, versioned docs, and custom React components, plus how to keep your URLs.",
      title: "How to migrate from Docusaurus to Blume",
    },
    nextStep: {
      body: "Run it at the root of your Docusaurus site, on a clean branch, then work through the review above.",
      command: "npx blume migrate docusaurus --claude",
      link: { href: "/docs/migrating", label: "Read the migration reference" },
      title: "Migrate your docs",
    },
    prerequisites: [
      "A Docusaurus site's repository",
      "Node.js 22.12 or later",
      "Claude Code or Codex, signed in",
    ],
    published: "2026-09-27",
    summary:
      "Move a Docusaurus site's docs to Blume with a coding agent, and check the sidebars, admonitions, and React components it carries over.",
    title: "Migrate your docs from Docusaurus",
    topic: "migrate",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/sources/obsidian", label: "Obsidian source" },
      { href: "/docs/content/sources", label: "Content sources" },
      {
        href: "/docs/content/frontmatter#sidebar",
        label: "Sidebar frontmatter",
      },
    ],
    id: "publish-obsidian-documentation",
    image: { src: "/guides/publish-obsidian-documentation.webp" },
    meta: {
      description:
        "Publish Obsidian notes as a documentation website: wikilinks, heading links, and images resolved at build time, straight from the vault with no export step.",
      title: "How to publish Obsidian notes as a documentation website",
    },
    nextStep: {
      body: "Scaffold a project with the Obsidian source, then move the notes you want public into its vault folder.",
      command: "npx blume init handbook-site",
      link: {
        href: "/docs/content/sources/obsidian",
        label: "Read the Obsidian source docs",
      },
      title: "Publish your vault",
    },
    prerequisites: [
      "A vault of notes that are safe to publish",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Publish a vault of Obsidian notes as a docs site, with wikilinks, heading links, and images resolved at build time.",
    title: "Publish Obsidian notes as a docs site",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/versioning", label: "Versioning" },
      { href: "/docs/cli/version", label: "blume version" },
      {
        href: "/docs/deployment#pattern-redirects",
        label: "Pattern redirects",
      },
    ],
    id: "version-markdown-documentation",
    image: { src: "/guides/version-markdown-documentation.webp" },
    meta: {
      description:
        "Version Markdown docs for an SDK: snapshot them before a breaking release, then give both versions a switcher, scoped search, and the right canonical URLs.",
      title: "How to version Markdown documentation for an SDK",
    },
    nextStep: {
      body: "Snapshot your docs as they are today, before the breaking change lands.",
      command: "npx blume version v1",
      link: {
        href: "/docs/content/versioning",
        label: "Read the versioning docs",
      },
      title: "Snapshot your docs",
    },
    prerequisites: [
      "A Blume project with Markdown or MDX docs",
      "A breaking release on the way",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Snapshot your docs before a breaking release, so readers on the old and new versions each find the right instructions.",
    title: "Version your docs for a breaking release",
    topic: "versioning",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/i18n", label: "Internationalization" },
      { href: "/docs/cli/translate", label: "blume translate" },
    ],
    id: "translate-markdown-documentation",
    image: { src: "/guides/translate-markdown-documentation.webp" },
    meta: {
      description:
        "Translate Markdown documentation with a coding agent, then keep every translation current with a CI check that fails when a source page changes.",
      title: "How to translate Markdown docs and detect outdated translations",
    },
    nextStep: {
      body: "Add a locale to your config, then translate your docs into it.",
      command: "npx blume translate --claude",
      link: { href: "/docs/cli/translate", label: "Read the translate docs" },
      title: "Translate your docs",
    },
    prerequisites: [
      "A Blume project with Markdown or MDX docs",
      "Claude Code or Codex, signed in",
      "A reviewer who reads the target language",
    ],
    published: "2026-09-27",
    summary:
      "Translate your docs with a coding agent, then keep them current with a CI check that fails when a source page changes.",
    title: "Translate your docs and catch stale translations",
    topic: "i18n",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      {
        href: "/docs/references/openapi#cors-and-the-proxy",
        label: "CORS and the proxy",
      },
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "fastapi-documentation-website",
    image: { src: "/guides/fastapi-documentation-website.webp" },
    meta: {
      description:
        "Give your FastAPI app a standalone documentation website: export its OpenAPI spec, add getting-started guides, and deploy the docs apart from the API.",
      title: "How to build a FastAPI documentation website with guides",
    },
    nextStep: {
      body: "Fail CI when a route or model changes without a fresh export, so the reference never drifts from the API.",
      link: {
        href: "/guides/openapi-documentation-ci",
        label: "Read the CI guide",
      },
      title: "Keep the spec in sync",
    },
    prerequisites: [
      "A FastAPI app, or Python 3.10 or later with uv",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Export your FastAPI app's OpenAPI spec without starting a server, and publish it as a separate docs site with a getting-started guide beside the API reference.",
    title: "Publish a FastAPI docs site with guides and API reference",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "hono-zod-api-documentation",
    image: { src: "/guides/hono-zod-api-documentation.webp" },
    meta: {
      description:
        "Generate Hono OpenAPI documentation from Zod schemas with @hono/zod-openapi: validate requests, document errors, and publish the spec with Blume.",
      title: "How to generate Hono OpenAPI documentation from Zod schemas",
    },
    nextStep: {
      body: "Scaffold it beside your Hono app, export your spec into it, and mount it with openapi().",
      command: "npx blume init docs-site --template docs --yes",
      link: {
        href: "/guides/openapi-documentation-ci",
        label: "Check the spec in CI",
      },
      title: "Add a docs site to your API",
    },
    prerequisites: [
      "Node.js 22.12 or later",
      "A Hono app, or the example built here",
      "Some TypeScript and Zod",
    ],
    published: "2026-09-27",
    summary:
      "A Hono API whose Zod schemas validate requests and generate its OpenAPI spec, published as a docs site with a page per route and a CI check that keeps it current.",
    title: "Generate documentation from Hono and Zod schemas",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      { href: "/docs/content/navigation", label: "Navigation" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "nestjs-api-documentation-website",
    image: { src: "/guides/nestjs-api-documentation-website.webp" },
    meta: {
      description:
        "Export NestJS Swagger JSON from your controllers and DTOs without a running server, then publish it as a docs site with a page per endpoint and guides.",
      title: "How to publish NestJS API documentation from Swagger metadata",
    },
    nextStep: {
      body: "Pick the code sample languages readers see, or turn on the Try it proxy if your API can't allow the docs origin.",
      link: {
        href: "/docs/references/openapi",
        label: "Read the OpenAPI reference docs",
      },
      title: "Fine-tune the reference",
    },
    prerequisites: [
      "A NestJS 12 app built with the Nest CLI",
      "Node.js 22.12 or later",
      "Controllers that take and return DTO classes",
    ],
    published: "2026-09-27",
    summary:
      "Turn NestJS controllers and DTOs into a docs site: a Swagger JSON export that needs no database, a page per endpoint with its auth, and a first-request guide beside them.",
    title: "Publish NestJS API documentation from Swagger metadata",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      {
        href: "/docs/references/openapi#try-it-playground",
        label: "Try it playground",
      },
      { href: "/docs/deployment#redirects", label: "Redirects" },
    ],
    id: "orpc-openapi-documentation",
    image: { src: "/guides/orpc-openapi-documentation.webp" },
    meta: {
      description:
        "Publish REST docs from oRPC contracts: add route metadata, generate an OpenAPI 3.1 spec from Zod schemas, and render an oRPC API reference with Blume.",
      title: "How to publish oRPC OpenAPI documentation as an API reference",
    },
    nextStep: {
      body: "Scaffold a docs site beside your oRPC project, generate the spec into it, and point the openapi() reference at the file.",
      command: "npx blume init docs-site --template docs --yes",
      link: {
        href: "/docs/references/openapi",
        label: "Read the OpenAPI reference docs",
      },
      title: "Publish your oRPC reference",
    },
    prerequisites: [
      "An oRPC 1 contract or router with Zod schemas, or the example built here",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Generate an OpenAPI document from your oRPC contract and publish it as an API reference, with a page per operation that updates when the contract changes.",
    title: "Publish API documentation from oRPC contracts",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      { href: "/docs/cli/validate", label: "blume validate" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "elysia-api-documentation",
    image: { src: "/guides/elysia-api-documentation.webp" },
    meta: {
      description:
        "Build a Bun API documentation website from Elysia: describe routes and errors with @elysia/openapi, export the spec, and publish it beside your tutorials.",
      title: "How to publish Elysia OpenAPI documentation with tutorials",
    },
    nextStep: {
      body: "Run it at the root of your Elysia project after exporting the spec, then point openapi() at docs-site/openapi.json.",
      command: "bunx blume init docs-site --template docs --yes",
      link: {
        href: "/docs/references/openapi",
        label: "Read the OpenAPI reference docs",
      },
      title: "Publish your Elysia API docs",
    },
    prerequisites: [
      "Bun, to run the Elysia API",
      "Node.js 22.12 or later, for Blume",
      "A Vercel account, or another static host",
    ],
    published: "2026-09-27",
    summary:
      "Describe your Elysia routes and errors so the OpenAPI spec matches the running API, then publish it as a docs site with tutorials beside a page per endpoint.",
    title: "Build an Elysia API documentation website",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      {
        href: "/docs/references/openapi#try-it-playground",
        label: "Try it playground",
      },
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "fastify-api-documentation",
    image: { src: "/guides/fastify-api-documentation.webp" },
    meta: {
      description:
        "Build a docs site from Fastify route schemas: register @fastify/swagger in the right order, export OpenAPI 3.1 to a file, and publish it with Blume.",
      title: "How to turn Fastify Swagger docs into an OpenAPI website",
    },
    nextStep: {
      body: "Run it at the root of your Fastify repository, then export the spec into it with the script from this guide.",
      command: "npx blume init docs-site --template docs --yes",
      link: {
        href: "/docs/references/openapi",
        label: "Read the OpenAPI reference docs",
      },
      title: "Scaffold the docs site",
    },
    prerequisites: [
      "A Fastify 5 app with JSON Schema on its routes",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Turn the JSON Schemas on your Fastify routes into an OpenAPI 3.1 file and a docs site with a page per route, a Try it panel, and guides beside the reference.",
    title: "Generate a Fastify documentation site from route schemas",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      { href: "/docs/deployment", label: "Deployment" },
      { href: "/docs/cli/validate", label: "Validate links" },
    ],
    id: "spring-boot-api-documentation",
    image: { src: "/guides/spring-boot-api-documentation.webp" },
    meta: {
      description:
        "Export your Spring Boot OpenAPI spec with springdoc during the Maven build, then publish static API docs with Blume, separate from the running Java service.",
      title: "How to publish a Spring Boot API documentation website",
    },
    nextStep: {
      body: "Check each pull request's spec for freshness and breaking changes, so a change that breaks clients or moves a page shows up in review.",
      link: {
        href: "/guides/openapi-documentation-ci",
        label: "Read the CI sync guide",
      },
      title: "Catch API changes in review",
    },
    prerequisites: [
      "A Spring Boot 4.1 API built with Maven",
      "JDK 21 or later",
      "Node.js 22.12 or later",
      "A GitHub repository",
    ],
    published: "2026-09-27",
    summary:
      "A Spring Boot API whose Maven build exports and checks its OpenAPI spec, and a static docs site built from that file in CI, with no docs endpoint in production.",
    title: "Publish Spring Boot API documentation with springdoc-openapi",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI reference" },
      {
        href: "/docs/references/openapi#authorization",
        label: "Authorization",
      },
      { href: "/docs/cli/validate", label: "Validate links" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "django-rest-framework-api-documentation",
    image: { src: "/guides/django-rest-framework-api-documentation.webp" },
    meta: {
      description:
        "Generate Django REST Framework documentation with drf-spectacular: fix schema warnings, publish static API reference pages, and add a first-request tutorial.",
      title: "How to build Django REST Framework docs with drf-spectacular",
    },
    nextStep: {
      body: "Allow the docs origin in your Django API, or turn on Blume's proxy, so the Try it panel reaches your API from the browser.",
      link: {
        href: "/guides/api-documentation-cors-errors",
        label: "Read the CORS guide",
      },
      title: "Let readers send real requests",
    },
    prerequisites: [
      "A Django REST Framework API, or Python 3.12 or later",
      "Node.js 22.12 or later",
      "A GitHub repository, for the CI step",
    ],
    published: "2026-09-27",
    summary:
      "A DRF API whose drf-spectacular schema generates without warnings, published as an API reference with a first-request tutorial beside it and rebuilt from code in CI.",
    title: "Build Django REST Framework docs with drf-spectacular",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/graphql", label: "GraphQL reference" },
      {
        href: "/docs/references/graphql#try-it-playground",
        label: "Try it and the proxy",
      },
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "graphql-documentation-website",
    image: { src: "/guides/graphql-documentation-website.webp" },
    meta: {
      description:
        "Use Blume as a GraphQL documentation generator: a page per query, mutation, and type from your schema, with type links, deprecations, and a Try it panel.",
      title: "How to generate GraphQL schema documentation for your API",
    },
    nextStep: {
      body: "Scaffold a project, copy your schema beside it, and add the graphql() reference to your config.",
      command: "npx blume init",
      link: {
        href: "/docs/references/graphql",
        label: "Read the GraphQL reference docs",
      },
      title: "Start your GraphQL docs",
    },
    prerequisites: [
      "A GraphQL schema as SDL or introspection JSON",
      "Node.js 22.12 or later",
      "A sandbox endpoint readers can query without a key",
    ],
    published: "2026-09-27",
    summary:
      "Turn a GraphQL schema into a docs site with a page per operation and type, linked types and deprecations, and a Try it panel that queries a sandbox.",
    title: "Generate GraphQL docs from your schema",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/asyncapi", label: "AsyncAPI reference" },
      { href: "/docs/content/includes", label: "Includes" },
      { href: "/docs/content/navigation", label: "Navigation" },
    ],
    id: "asyncapi-kafka-documentation",
    image: { src: "/guides/asyncapi-kafka-documentation.webp" },
    meta: {
      description:
        "Write AsyncAPI Kafka documentation: topics as channels, send and receive operations, SASL security, and an event reference beside tested client code.",
      title: "How to write AsyncAPI Kafka documentation for your event topics",
    },
    nextStep: {
      body: "Run the AsyncAPI validator on your document, then add it to the reference and build.",
      command: "npx @asyncapi/cli@6.2.0 validate asyncapi.yaml",
      link: {
        href: "/docs/references/asyncapi",
        label: "Read the AsyncAPI reference docs",
      },
      title: "Validate your event contract",
    },
    prerequisites: [
      "A Blume project",
      "Node.js 22.12 or later",
      "A Kafka broker to test against, or Docker to run one",
    ],
    published: "2026-09-27",
    summary:
      "Describe your Kafka topics in AsyncAPI, publish event-driven API documentation with a page per operation, and pair it with producer and consumer code you've run.",
    title: "Document Kafka events with AsyncAPI",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/references/openapi#webhooks-and-callbacks",
        label: "Webhooks and callbacks",
      },
      { href: "/docs/references/openapi", label: "OpenAPI" },
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
    ],
    id: "openapi-webhook-documentation",
    image: { src: "/guides/openapi-webhook-documentation.webp" },
    meta: {
      description:
        "Write OpenAPI webhook documentation: define each event under webhooks, document its payload, signature headers, and retries, and publish a page per webhook.",
      title: "How to document webhook payloads with OpenAPI 3.1",
    },
    nextStep: {
      body: "Check the spec on every pull request, so the reference can't drift from what your API actually sends.",
      link: {
        href: "/guides/openapi-documentation-ci",
        label: "Keep API docs in sync in CI",
      },
      title: "Keep the spec and docs in sync",
    },
    prerequisites: [
      "An OpenAPI spec for the API that sends the webhooks",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Webhook pages generated from your OpenAPI 3.1 spec, with payloads, signature headers, and acknowledgments, plus a receiving guide with a working Node.js receiver.",
    title: "Write webhook documentation with OpenAPI 3.1",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/references/openapi#multiple-specs",
        label: "Multiple specs",
      },
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
      { href: "/docs/references/openapi#overlays", label: "OpenAPI overlays" },
      { href: "/docs/content/meta", label: "Folder meta" },
    ],
    id: "multiple-openapi-specs-documentation",
    image: { src: "/guides/multiple-openapi-specs-documentation.webp" },
    meta: {
      description:
        "Document multiple OpenAPI specs in one API documentation portal: give each spec its own route and tab, and keep shared operation names apart in search.",
      title: "How to publish multiple OpenAPI specs in one API docs portal",
    },
    nextStep: {
      body: "Run doctor in your project to catch two specs claiming the same route before a build drops one of them.",
      command: "npx blume doctor",
      link: { href: "/docs/cli/doctor", label: "Read the doctor docs" },
      title: "Check your routes",
    },
    prerequisites: [
      "A Blume site (the OpenAPI guide shows how to start one)",
      "Two or more OpenAPI specs in YAML or JSON",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "An API portal with a reference per service: each OpenAPI spec on its own route and tab, and shared operation names kept apart in URLs, sidebars, and search.",
    title: "Combine multiple OpenAPI specifications in one docs site",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/references/openapi#your-own-samples",
        label: "Your own code samples",
      },
      {
        href: "/docs/references/openapi#code-samples-and-schemas",
        label: "Generated code samples",
      },
      { href: "/docs/references/openapi#overlays", label: "OpenAPI overlays" },
    ],
    id: "openapi-sdk-code-samples",
    image: { src: "/guides/openapi-sdk-code-samples.webp" },
    meta: {
      description:
        "Show SDK calls in generated API docs with x-codeSamples: TypeScript and Python tabs, generated HTTP samples kept or dropped, and a check for every sample.",
      title: "How to add SDK code samples to OpenAPI docs with x-codeSamples",
    },
    nextStep: {
      body: "Run the sample check beside your docs build, so a spec change or an SDK bump that breaks a sample fails the pull request.",
      link: {
        href: "/guides/openapi-documentation-ci",
        label: "Read the CI guide",
      },
      title: "Check your samples in CI",
    },
    prerequisites: [
      "A Blume site with an OpenAPI reference",
      "An SDK for your API on npm or PyPI",
      "Node.js 22.12 or later, and Python 3 for the Python check",
    ],
    published: "2026-09-27",
    summary:
      "Operation pages that open on your TypeScript and Python SDK calls, with the generated HTTP samples kept or dropped, and a check that catches samples an SDK release broke.",
    title: "Add SDK examples to generated API documentation",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/api-pages", label: "Hand-written API pages" },
      { href: "/docs/content/components#api-fields", label: "API fields" },
      { href: "/docs/content/includes", label: "Includes" },
      {
        href: "/docs/references/openapi#cors-and-the-proxy",
        label: "CORS and the proxy",
      },
    ],
    id: "api-documentation-without-openapi",
    image: { src: "/guides/api-documentation-without-openapi.webp" },
    meta: {
      description:
        "Write API documentation in Markdown without an OpenAPI spec: MDX endpoint pages with a Try it playground, request samples, auth, and response examples.",
      title: "How to create API documentation without an OpenAPI spec",
    },
    nextStep: {
      body: "Readers call your API from their browser, so allow your docs origin with CORS or route requests through the proxy before you publish.",
      link: {
        href: "/guides/api-documentation-cors-errors",
        label: "Read the CORS guide",
      },
      title: "Make Try it work in production",
    },
    prerequisites: [
      "Node.js 22.12 or later",
      "An HTTP API to document, or the sample API in this guide",
      "curl, to check requests from a terminal",
    ],
    published: "2026-09-27",
    summary:
      "Three hand-written MDX endpoint pages with a Try it panel, request samples, and response examples, tested against a local sample API. No spec needed.",
    title: "Create interactive API documentation without an OpenAPI spec",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/references/openapi#cors-and-the-proxy",
        label: "CORS and the proxy",
      },
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
      { href: "/docs/configuration/rate-limiting", label: "Rate limiting" },
    ],
    id: "api-documentation-cors-errors",
    image: { src: "/guides/api-documentation-cors-errors.webp" },
    meta: {
      description:
        "Why an API request works in curl but fails in your docs playground or Swagger UI: read the CORS preflight, fix your API's policy, or use a proxy.",
      title: "How to fix CORS errors in an API documentation playground",
    },
    nextStep: {
      body: "Send your staging or production API the preflight a browser would, with your docs origin, and check it answers 2xx with the headers from this guide.",
      link: {
        href: "/docs/references/openapi#cors-and-the-proxy",
        label: "Read the playground CORS docs",
      },
      title: "Replay your API's preflight",
    },
    prerequisites: [
      "A Blume site with a Try it panel (OpenAPI, GraphQL, or hand-written pages)",
      "An API you can change, or a server host for the proxy",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Reproduce a blocked Try it request, read the preflight the browser sends, and fix it with a CORS policy on your API or Blume's built-in proxy.",
    title: "Fix CORS errors in an API documentation playground",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/references/openapi", label: "OpenAPI" },
      { href: "/docs/cli/validate", label: "Validate" },
      { href: "/docs/cli/audit", label: "Audit" },
    ],
    id: "openapi-documentation-ci",
    image: { src: "/guides/openapi-documentation-ci.webp" },
    meta: {
      description:
        "Export your OpenAPI spec from code, fail pull requests when it's stale, invalid, or breaking, and rebuild your API docs from it on every change.",
      title: "How to keep API docs in sync with your OpenAPI spec in CI",
    },
    nextStep: {
      body: "If the exported spec includes internal endpoints, hide them with an overlay instead of editing the generated file, so the freshness check keeps passing.",
      link: {
        href: "/guides/openapi-overlays-public-docs",
        label: "Remove internal endpoints",
      },
      title: "Trim the spec for public docs",
    },
    prerequisites: [
      "A backend that can export its OpenAPI spec",
      "A Blume project with an OpenAPI reference",
      "A GitHub repository with Actions enabled",
      "Node.js 22.18 or later",
    ],
    published: "2026-09-27",
    summary:
      "A GitHub Actions workflow that exports your OpenAPI spec from the backend, fails when it's stale, invalid, or breaking, and rebuilds the API reference from it.",
    title: "Keep API documentation in sync with backend changes in CI",
    topic: "reference",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/sources/sanity", label: "Sanity source" },
      { href: "/docs/content/sources/custom", label: "Custom sources" },
      {
        href: "/docs/content/sources#preview-and-sync",
        label: "Preview and sync",
      },
      { href: "/docs/deployment#private-docs", label: "Private docs" },
    ],
    id: "sanity-documentation-website",
    image: { src: "/guides/sanity-documentation-website.webp" },
    meta: {
      description:
        "Use Sanity as a docs CMS: map a guide schema and Portable Text into Markdown pages, render custom blocks, keep draft previews protected, and rebuild on publish.",
      title: "How to build a Sanity documentation website with Markdown docs",
    },
    nextStep: {
      body: "Pick filesystem and sanity when init asks where your content lives, then point the source at your project ID and query.",
      command: "npx blume init",
      link: {
        href: "/docs/content/sources/sanity",
        label: "Read the Sanity source docs",
      },
      title: "Connect your dataset",
    },
    prerequisites: [
      "A Sanity project and its Studio",
      "Node.js 22.12 or later",
      "A Vercel account for the deploy steps",
    ],
    published: "2026-09-27",
    summary:
      "Editors write guides in Sanity Studio while developers keep Markdown in Git, and one docs site serves both, with drafts only in protected previews.",
    title: "Use Sanity as a CMS for developer documentation",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/sources/payload", label: "Payload source" },
      { href: "/docs/content/sources/custom", label: "Custom sources" },
      {
        href: "/docs/content/sources#preview-and-sync",
        label: "Preview and sync",
      },
      { href: "/docs/deployment#private-docs", label: "Private docs" },
    ],
    id: "payload-cms-documentation-website",
    image: { src: "/guides/payload-cms-documentation-website.webp" },
    meta: {
      description:
        "Turn a Payload CMS collection into a documentation website or knowledge base, with Lexical pages, uploads, code blocks, draft previews, and rebuilds on publish.",
      title: "How to build a documentation website with Payload CMS",
    },
    nextStep: {
      body: "Pick payload when init asks where your content lives, then point the source at your collection and set PAYLOAD_API_KEY.",
      command: "npx blume init",
      link: {
        href: "/docs/content/sources/payload",
        label: "Read the Payload source docs",
      },
      title: "Publish your Payload docs",
    },
    prerequisites: [
      "A Payload 3 app, or a few minutes to create one",
      "A Payload deployment your docs build can reach",
      "Node.js 22.12 or later",
      "A Vercel account for the deploy steps",
    ],
    published: "2026-09-27",
    summary:
      "Publish a Payload collection as a searchable docs site, with Lexical pages, images, and code blocks, draft previews, and a rebuild whenever an editor publishes.",
    title: "Build a documentation website with Payload CMS",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/sources/contentful", label: "Contentful source" },
      {
        href: "/docs/content/sources#preview-and-sync",
        label: "Preview and sync",
      },
      { href: "/docs/content/sources/custom", label: "Custom sources" },
      { href: "/docs/deployment#private-docs", label: "Private docs" },
    ],
    id: "contentful-documentation-website",
    image: { src: "/guides/contentful-documentation-website.webp" },
    meta: {
      description:
        "Publish Contentful technical documentation as a docs site: model pages and code blocks, set delivery and preview tokens, preview drafts, and rebuild on publish.",
      title: "How to publish a Contentful documentation website",
    },
    nextStep: {
      body: "Pick contentful when init asks where your content lives, then set your space ID and content type in the config.",
      command: "npx blume init",
      link: {
        href: "/docs/content/sources/contentful",
        label: "Read the Contentful source docs",
      },
      title: "Connect your Contentful space",
    },
    prerequisites: [
      "A Contentful space where you can change the content model",
      "Node.js 22.12 or later",
      "A Vercel account for the deploy steps",
    ],
    published: "2026-09-27",
    summary:
      "Model docs pages and code blocks in Contentful, review drafts with a preview token, and publish a static docs site that rebuilds whenever an editor publishes.",
    title: "Publish developer documentation from Contentful",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/sources/strapi", label: "Strapi source" },
      {
        href: "/docs/content/sources#preview-and-sync",
        label: "Preview and sync",
      },
      { href: "/docs/configuration#images", label: "Remote images" },
      { href: "/docs/deployment#private-docs", label: "Private docs" },
    ],
    id: "strapi-documentation-website",
    image: { src: "/guides/strapi-documentation-website.webp" },
    meta: {
      description:
        "Build a static documentation website or knowledge base from Strapi 5: model docs with Blocks, keep drafts private, and rebuild whenever an editor publishes.",
      title: "How to publish a static documentation website from Strapi",
    },
    nextStep: {
      body: "Pick strapi when init asks where your content lives, then point the source at your docs content type.",
      command: "npx blume init",
      link: {
        href: "/docs/content/sources/strapi",
        label: "Read the Strapi source docs",
      },
      title: "Connect your Strapi",
    },
    prerequisites: [
      "A Strapi 5 project you can administer",
      "Node.js 22.12 or later",
      "A Vercel account for the deploy steps",
    ],
    published: "2026-09-27",
    summary:
      "Editors write and publish in Strapi, readers get a static docs site, and every publish starts a fresh build, with drafts kept off production.",
    title: "Use Strapi to manage a documentation website",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/sources/remote-mdx", label: "Remote MDX" },
      {
        href: "/docs/content/sources#caching-and-offline-builds",
        label: "Caching and offline builds",
      },
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
      { href: "/docs/cli/validate", label: "blume validate" },
    ],
    id: "documentation-multiple-repositories",
    image: { src: "/guides/documentation-multiple-repositories.webp" },
    meta: {
      description:
        "Combine documentation from multiple repositories into one GitHub docs portal: mount each repo under its own path and pin releases, with tokens and links.",
      title: "How to build documentation from multiple GitHub repositories",
    },
    nextStep: {
      body: "Scaffold a portal, select mdx-remote when it asks where your content lives, and point the source at one repository's docs folder.",
      command: "npx blume init acme-docs",
      link: {
        href: "/docs/content/sources/remote-mdx",
        label: "Read the remote MDX reference",
      },
      title: "Mount your first repository",
    },
    prerequisites: [
      "Two or more GitHub repositories with Markdown or MDX docs",
      "Node.js 22.12 or later",
      "A GitHub token, if any repository is private",
    ],
    published: "2026-09-27",
    summary:
      "One docs site that pulls each repository's docs folder from GitHub at build time, under its own path, pinned to a release that moves only when you change it.",
    title: "Build one docs portal from multiple GitHub repositories",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/sources", label: "Content sources" },
      { href: "/docs/content/sources/notion", label: "Notion source" },
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
      { href: "/docs/cli/validate", label: "Validate" },
    ],
    id: "markdown-notion-documentation",
    image: { src: "/guides/markdown-notion-documentation.webp" },
    meta: {
      description:
        "Run a hybrid docs CMS: engineers write Markdown in Git, teammates edit a Notion database, and one build publishes both with shared navigation and search.",
      title: "How to combine Markdown and Notion docs in one site",
    },
    nextStep: {
      body: "Install the Notion SDK in your Blume project, then add a prefixed notion() source next to filesystem().",
      command: "npm install @notionhq/client",
      link: {
        href: "/docs/content/sources/notion",
        label: "Read the Notion source docs",
      },
      title: "Add Notion beside your Markdown",
    },
    prerequisites: [
      "A Blume project with Markdown in Git",
      "A Notion database and a connection token",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "One docs site where engineers write Markdown in Git and teammates edit Notion, with a section each, checks that keep their URLs apart, and one build for both.",
    title: "Combine Markdown and Notion in one documentation site",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/content/sources/github-releases",
        label: "GitHub Releases source",
      },
      { href: "/docs/advanced/changelog", label: "Changelogs" },
      { href: "/docs/discoverability/rss", label: "RSS feeds" },
      {
        href: "/docs/content/sources#caching-and-offline-builds",
        label: "Source caching",
      },
    ],
    id: "github-releases-changelog-website",
    image: { src: "/guides/github-releases-changelog-website.webp" },
    meta: {
      description:
        "Automate your product changelog from GitHub releases: a page per release, a timeline and RSS feed on your docs site, and a rebuild each time you publish.",
      title: "How to turn GitHub releases into a changelog website",
    },
    nextStep: {
      body: "Keep filesystem selected and add github-releases when init asks where your content lives, then set your owner and repo in the config.",
      command: "npx blume init",
      link: {
        href: "/docs/content/sources/github-releases",
        label: "Read the GitHub Releases docs",
      },
      title: "Add your releases",
    },
    prerequisites: [
      "A GitHub repository that publishes releases",
      "A Blume docs site, or Node.js 22.12 or later",
      "A GitHub token, if the repository is private",
    ],
    published: "2026-09-27",
    summary:
      "Write release notes once on GitHub and get a changelog timeline, a page per release, and an RSS feed on your docs site, rebuilt every time you publish.",
    title: "Turn GitHub releases into a product changelog",
    topic: "sources",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/includes", label: "Includes" },
      { href: "/docs/content/variables", label: "Variables" },
      { href: "/docs/cli/validate", label: "blume validate" },
      {
        href: "/docs/discoverability/markdown#raw-markdown",
        label: "Markdown mirrors",
      },
    ],
    id: "reuse-markdown-snippets",
    image: { src: "/guides/reuse-markdown-snippets.webp" },
    meta: {
      description:
        "Keep install steps and version strings in one place: share MDX includes across pages, pass the one value that differs, and define variables once.",
      title: "How to reuse Markdown content with MDX includes and variables",
    },
    nextStep: {
      body: "Run validate in CI, so a missing include, an include loop, or an undefined variable fails the pull request that caused it.",
      command: "npx blume validate",
      link: {
        href: "/guides/markdown-link-checking-ci",
        label: "Read the link-checking guide",
      },
      title: "Check snippets on every pull request",
    },
    prerequisites: [
      "A Blume project with a docs folder",
      "Node.js 22.12 or later",
      "Two or more pages that repeat the same steps",
    ],
    published: "2026-09-27",
    summary:
      "Three guides that share one setup section through MDX includes, with one intentional variation, version strings defined once, and a way to check every page a change reaches.",
    title: "Reuse Markdown snippets and variables across documentation",
    topic: "writing",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/content/frontmatter#per-type-keys",
        label: "Per-type frontmatter keys",
      },
      {
        href: "/docs/discoverability/mcp#scoping-by-content-type-and-facets",
        label: "MCP type and facet filters",
      },
      {
        href: "/docs/content/navigation#directory-listings",
        label: "Directory listings",
      },
      { href: "/docs/deployment#private-docs", label: "Private docs" },
    ],
    id: "engineering-handbook-markdown",
    image: { src: "/guides/engineering-handbook-markdown.webp" },
    meta: {
      description:
        "Keep RFCs, ADRs, and runbooks as Markdown in Git, require owners and statuses, and publish an ADR documentation website that agents can filter by type.",
      title: "How to build a Markdown engineering handbook with ADRs and RFCs",
    },
    nextStep: {
      body: "Scaffold a project, add the three content types to its config, and move your first decision record in.",
      command: "npx blume init acme-handbook --template docs",
      link: {
        href: "/docs/configuration#frontmatter",
        label: "Read the frontmatter config reference",
      },
      title: "Start your handbook",
    },
    prerequisites: [
      "Node.js 22.12 or later",
      "A Git repository for the handbook",
      "Claude Code or another MCP client, for the agent step",
    ],
    published: "2026-09-27",
    summary:
      "A handbook of RFCs, decision records, and runbooks where the build rejects a missing owner or status, and agents can list documents by type, team, or status.",
    title: "Build an engineering handbook with RFCs, ADRs, and runbooks",
    topic: "writing",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/deployment#subpath-deploys", label: "Subpath deploys" },
      {
        href: "/docs/deployment#mount-the-docs-under-a-path",
        label: "Mount the docs under a path",
      },
      {
        href: "/docs/content/navigation#header-actions",
        label: "Header actions",
      },
      { href: "/docs/discoverability/markdown", label: "Markdown for agents" },
    ],
    id: "nextjs-documentation-subpath",
    image: { src: "/guides/nextjs-documentation-subpath.webp" },
    meta: {
      description:
        "Keep your Next.js app and serve a separate docs site at example.com/docs: set deployment.base, add one rewrite, and test pages, assets, and canonical URLs.",
      title: "How to serve documentation on a Next.js subpath with rewrites",
    },
    nextStep: {
      body: "Scaffold it beside your Next.js app, then set deployment.base and site as this guide does.",
      command: "npx blume init acme-docs",
      link: {
        href: "/docs/deployment#subpath-deploys",
        label: "Read the deployment reference",
      },
      title: "Start the docs project",
    },
    prerequisites: [
      "A Next.js app using the App Router",
      "Node.js 22.12 or later",
      "A Vercel account for the docs project",
    ],
    published: "2026-09-27",
    summary:
      "Deploy Blume as its own static site under /docs, proxy it through one Next.js rewrite, and check pages, assets, canonical URLs, and llms.txt through your domain.",
    title: "Serve a separate docs site under /docs in Next.js",
    topic: "deploy",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
      { href: "/docs/discoverability/mcp", label: "MCP server" },
      {
        href: "/docs/discoverability/agent-discovery",
        label: "Agent discovery",
      },
    ],
    id: "self-host-documentation-docker",
    image: { src: "/guides/self-host-documentation-docker.webp" },
    meta: {
      description:
        "Run a self-hosted documentation site in Docker: build with the Node adapter, ship its dependencies, and serve pages and an MCP endpoint from your server.",
      title: "How to self-host documentation and an MCP server with Docker",
    },
    nextStep: {
      body: "Once your domain reaches the container, add its MCP endpoint to Claude Code, Cursor, or VS Code, and see what else the server offers agents.",
      link: {
        href: "/guides/mcp-server-for-documentation",
        label: "Read the MCP server guide",
      },
      title: "Connect an agent to your docs",
    },
    prerequisites: [
      "A Blume project with a package-lock.json",
      "Docker with Compose",
      "A server, and a domain pointed at it for HTTPS",
      "Node.js 22.12 or later, to build locally",
    ],
    published: "2026-09-27",
    summary:
      "A Docker image that serves your docs and MCP endpoint from Node.js, run with Compose behind Caddy, with a health check and tests for pages and discovery files.",
    title: "Self-host documentation with Docker and Node.js",
    topic: "deploy",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
      { href: "/docs/discoverability/mcp", label: "MCP server" },
      {
        href: "/docs/discoverability/markdown#content-negotiation",
        label: "Markdown content negotiation",
      },
    ],
    id: "cloudflare-workers-documentation",
    image: { src: "/guides/cloudflare-workers-documentation.webp" },
    meta: {
      description:
        "Host a Cloudflare Workers documentation site with Blume: pages served as static assets, plus an MCP endpoint and Markdown for agents from one Worker.",
      title: "How to deploy a docs site and MCP server to Cloudflare Workers",
    },
    nextStep: {
      body: "Turn it on in blume.config.ts and store its model key as a Worker secret; it answers readers from the same pages the MCP server reads.",
      link: {
        href: "/guides/ai-assistant-for-documentation",
        label: "Read the assistant guide",
      },
      title: "Add the assistant to the same Worker",
    },
    prerequisites: [
      "A Blume docs project",
      "A Cloudflare account",
      "Node.js 22.12 or later",
      "A domain on Cloudflare, for a custom domain",
    ],
    published: "2026-09-27",
    summary:
      "One Cloudflare Worker that serves your docs as static assets, answers Markdown requests at the same URLs, and hosts an MCP endpoint coding agents connect to.",
    title: "Deploy docs and an MCP server to Cloudflare Workers",
    topic: "deploy",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/deployment#private-docs", label: "Private docs" },
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
      { href: "/docs/discoverability/mcp", label: "MCP server" },
      { href: "/docs/discoverability/json-api", label: "JSON API" },
    ],
    id: "private-documentation-cloudflare-access",
    image: { src: "/guides/private-documentation-cloudflare-access.webp" },
    meta: {
      description:
        "Put a private documentation website behind company SSO with Cloudflare Access, and check every page, Markdown copy, search file, and MCP endpoint for leaks.",
      title: "How to host private documentation behind Cloudflare Access",
    },
    nextStep: {
      body: "Once every signed-out line shows a dash, move your real pages into docs/, deploy again, and rerun the check.",
      link: {
        href: "/docs/deployment#private-docs",
        label: "Read the private docs reference",
      },
      title: "Publish your real handbook",
    },
    prerequisites: [
      "A domain on your Cloudflare account",
      "Cloudflare Zero Trust set up on that account",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A private docs site on Cloudflare Workers that only your company can open, with every page, Markdown copy, search index, and agent endpoint checked behind Access.",
    title: "Protect private docs with Cloudflare Access",
    topic: "deploy",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/quickstart", label: "Quickstart" },
      {
        href: "/docs/content/components#component",
        label: "Component examples",
      },
      { href: "/docs/content/sources", label: "Content sources" },
      { href: "/docs/deployment", label: "Deployment" },
    ],
    id: "monorepo-documentation-site",
    image: { src: "/guides/monorepo-documentation-site.webp" },
    meta: {
      description:
        "Add monorepo documentation as its own pnpm and Turborepo workspace, show live examples from shared packages, and deploy it apart from your app builds.",
      title: "How to add a Turborepo docs app to your monorepo",
    },
    nextStep: {
      body: "Run it from the repository root, then approve esbuild in pnpm-workspace.yaml, install, and give the docs their own turbo.json.",
      command:
        "pnpm dlx --allow-build=esbuild blume init apps/docs --yes --template docs --no-install",
      link: { href: "/docs/deployment", label: "Read the deployment docs" },
      title: "Scaffold the docs workspace",
    },
    prerequisites: [
      "A pnpm workspace that builds with Turborepo",
      "Node.js 22.12 or later",
      "A Vercel account, for the deploy step",
    ],
    published: "2026-09-27",
    summary:
      "A docs workspace beside your app that shows live examples from a shared package, builds with Turborepo, and deploys on its own, skipping commits it isn't part of.",
    title: "Add documentation to a monorepo without breaking app builds",
    topic: "deploy",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/deployment", label: "Deployment" },
      { href: "/docs/deployment#content-types", label: "Content types" },
      { href: "/docs/discoverability/markdown", label: "Markdown for agents" },
      { href: "/docs/discoverability/json-api", label: "JSON API" },
    ],
    id: "s3-cloudfront-documentation-site",
    image: { src: "/guides/s3-cloudfront-documentation-site.webp" },
    meta: {
      description:
        "Host static documentation on S3 and CloudFront: a private bucket with origin access control, clean page URLs, correct Markdown types, and caching you control.",
      title: "How to host static docs on AWS with S3 and CloudFront",
    },
    nextStep: {
      body: "Run it at the top of deploy.sh, so a broken link stops the deploy before anything reaches the bucket.",
      command: "npx blume validate",
      link: { href: "/docs/cli/validate", label: "Read the validate docs" },
      title: "Check links before you upload",
    },
    prerequisites: [
      "An AWS account and the AWS CLI, signed in",
      "A domain whose DNS records you can edit",
      "A Blume project on Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A private S3 bucket behind CloudFront that serves every page at its clean URL, Markdown and JSON with the right types, real 404s, and a cache each deploy clears.",
    title: "Host static documentation on S3 and CloudFront",
    topic: "deploy",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
      {
        href: "/docs/configuration/assistant#external-endpoint",
        label: "External assistant endpoint",
      },
      { href: "/docs/configuration/search", label: "Search adapters" },
      { href: "/docs/discoverability/mcp", label: "MCP server" },
    ],
    id: "static-vs-server-documentation",
    image: { src: "/guides/static-vs-server-documentation.webp" },
    meta: {
      description:
        "Which docs features need a backend? Map search, the assistant, MCP, and an API proxy to static files or live endpoints, then build one site both ways.",
      title: "Static vs dynamic documentation: which features need a server",
    },
    nextStep: {
      body: "Run doctor in your project. It prints the output mode and adapter, and names any feature that needs server output before you build.",
      command: "npx blume doctor",
      link: {
        href: "/docs/deployment#server-rendering",
        label: "Read the server rendering docs",
      },
      title: "Check your own config",
    },
    prerequisites: [
      "Node.js 22.12 or later",
      "A Blume project, or a folder to start one in",
      "An AI Gateway API key, to try the built-in assistant (optional)",
    ],
    published: "2026-09-27",
    summary:
      "Map each docs feature to static files or a live endpoint, build the same site both ways, and check what each build ships and what you would have to run.",
    title: "Choose static or server-rendered documentation",
    topic: "deploy",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/configuration/rate-limiting", label: "Rate limiting" },
      {
        href: "/docs/configuration/assistant#bot-protection",
        label: "Assistant bot protection",
      },
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
    ],
    id: "rate-limit-documentation-ai-assistant",
    image: { src: "/guides/rate-limit-documentation-ai-assistant.webp" },
    meta: {
      description:
        "Rate limit your docs AI chatbot: reproduce the per-reader limit, share the count across serverless instances, test the 429s and recovery, and add a bot check.",
      title: "How to rate limit and protect a documentation AI chatbot",
    },
    nextStep: {
      body: "Run it after switching to upstash(): the summary names the rate limiter, and a missing Upstash variable shows up as a warning.",
      command: "npx blume doctor",
      link: {
        href: "/docs/configuration/rate-limiting",
        label: "Read the rate limiting docs",
      },
      title: "Check which limiter runs",
    },
    prerequisites: [
      "A Blume site with the assistant turned on",
      "A host adapter, such as vercel() or cloudflare()",
      "An Upstash Redis database, if you deploy to Vercel or Netlify",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A per-reader limit on your docs assistant that holds across serverless instances, a load test that shows the 429s and the reset, and a bot check for scripts.",
    title: "Rate-limit a public documentation AI assistant",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/configuration/assistant", label: "Assistant" },
      { href: "/docs/cli/evals", label: "Evals" },
      { href: "/docs/configuration/rate-limiting", label: "Rate limiting" },
    ],
    id: "ai-assistant-for-documentation",
    image: { src: "/guides/ai-assistant-for-documentation.webp" },
    meta: {
      description:
        "Add an AI chatbot to your documentation that answers from your pages and cites them, keep the API key on the server, and test it with a small evaluation set.",
      title: "How to add an AI chatbot to your documentation with citations",
    },
    nextStep: {
      body: "Have an agent draft an evals file from your existing pages, then run blume eval to find the questions your docs can't answer yet.",
      command: "npx blume eval init",
      link: {
        href: "/guides/documentation-evals-ci",
        label: "Read the evals guide",
      },
      title: "Test what your docs can answer",
    },
    prerequisites: [
      "A Blume docs project",
      "A host that runs server code, like Vercel",
      "A Vercel AI Gateway API key",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "An in-page assistant that answers from your docs and links its sources, a support handoff for what they don't cover, and an evaluation set that shows where it fails.",
    title: "Add an AI assistant that answers from your documentation",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/configuration/assistant#cross-origin-callers",
        label: "Cross-origin callers",
      },
      {
        href: "/docs/configuration/assistant#external-endpoint",
        label: "External endpoint",
      },
      { href: "/docs/configuration/rate-limiting", label: "Rate limiting" },
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
    ],
    id: "embed-documentation-chatbot",
    image: { src: "/guides/embed-documentation-chatbot.webp" },
    meta: {
      description:
        "Call your documentation assistant API from your own app: allow your origin with CORS, stream answers into a React chat panel, and handle errors and limits.",
      title: "How to embed a documentation chatbot inside your app",
    },
    nextStep: {
      body: "The route stays public whatever the CORS list says. Give it a rate limit every server instance shares before product traffic reaches it.",
      link: {
        href: "/guides/rate-limit-documentation-ai-assistant",
        label: "Rate-limit the assistant",
      },
      title: "Protect the route",
    },
    prerequisites: [
      "A Blume docs site on a host with server functions",
      "A React app on another origin",
      "An AI Gateway key, or a Vercel deployment",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A chat panel in your React app that streams answers from your Blume docs, knows which page covers the current screen, and links every source back to the docs.",
    title: "Embed your documentation assistant inside your product",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/configuration/assistant#openai-compatible-endpoints",
        label: "OpenAI-compatible endpoints",
      },
      {
        href: "/docs/configuration/assistant#retrieval-size",
        label: "Retrieval size",
      },
      {
        href: "/docs/configuration/assistant#searching-and-reading-pages",
        label: "Assistant docs tools",
      },
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
    ],
    id: "ollama-documentation-assistant",
    image: { src: "/guides/ollama-documentation-assistant.webp" },
    meta: {
      description:
        "Run your documentation chatbot on a local LLM with Ollama: connect Blume over Chat Completions, test tool calling, tune retrieval, compare to a hosted model.",
      title: "How to run a documentation chatbot on a local LLM with Ollama",
    },
    nextStep: {
      body: "Every question runs on your own machine. Add a bot check, and let the rate limit count each reader behind your proxy, so scripts can't queue up work for your model.",
      link: {
        href: "/guides/rate-limit-documentation-ai-assistant",
        label: "Read the rate limiting guide",
      },
      title: "Put a limit on your hardware",
    },
    prerequisites: [
      "A Blume docs project",
      "A Linux server or a Mac to run the model on",
      "Ollama 0.34.4",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A docs assistant that answers from your pages with a model running in Ollama beside your docs server, sized for your hardware and measured against a hosted model.",
    title: "Run a documentation assistant with Ollama",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/cli/evals", label: "Evals" },
      { href: "/docs/discoverability/mcp", label: "MCP server" },
      {
        href: "/docs/configuration/search#excluding-pages",
        label: "Excluding pages from search",
      },
    ],
    id: "documentation-evals-ci",
    image: { src: "/guides/documentation-evals-ci.webp" },
    meta: {
      description:
        "Test documentation with AI: turn real support questions into evals, let an agent answer from your docs alone, and fail CI when the docs can't answer.",
      title: "How to test documentation with AI evals in CI",
    },
    nextStep: {
      body: "Have an agent draft questions from your docs, then add the ones your users actually asked.",
      command: "npx blume eval init --agent claude",
      link: { href: "/docs/cli/evals", label: "Read the evals docs" },
      title: "Draft your first evals file",
    },
    prerequisites: [
      "A Blume docs project in a GitHub repository",
      "Claude Code, installed and signed in",
      "An Anthropic API key for the CI job",
      "A few questions from support threads or issues",
    ],
    published: "2026-09-27",
    summary:
      "An evals file built from real support questions, a failing run traced to the page that should answer, the fix that turns it green, and a CI gate on docs changes.",
    title: "Test whether your documentation can answer user questions",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/advanced/skills", label: "Skills" },
      { href: "/docs/cli/validate", label: "Validate" },
      { href: "/docs/cli", label: "CLI overview" },
    ],
    id: "keep-documentation-updated-agent",
    image: { src: "/guides/keep-documentation-updated-agent.webp" },
    meta: {
      description:
        "Set up docs drift detection with Blume's update-docs agent skill: test it on a known change, review its evidence-backed pull request, then run it weekly in CI.",
      title: "How to automatically update documentation from code changes",
    },
    nextStep: {
      body: "Add it at the root of the repository that holds your code and docs, then run it on one pull request you know changed documented behavior.",
      command:
        "npx skills add haydenbleasel/blume --skill blume-update-docs --agent claude-code",
      link: {
        href: "/docs/advanced/skills#self-updating-docs",
        label: "Read the skills reference",
      },
      title: "Install the update-docs skill",
    },
    prerequisites: [
      "A Blume docs site in the same repository as your code",
      "Claude Code or another agent that loads skills",
      "The GitHub CLI, signed in",
      "Admin access to the repository, for the scheduled run",
    ],
    published: "2026-09-27",
    summary:
      "A coding agent reads your merged pull requests, fixes only the docs they made wrong, shows its evidence in a pull request for review, and runs weekly in GitHub Actions.",
    title: "Keep documentation updated from merged code changes",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/discoverability/agent-discovery#your-sites-skill",
        label: "Your site's skill",
      },
      {
        href: "/docs/discoverability/agent-discovery#skills-discovery",
        label: "Skills discovery",
      },
      {
        href: "/docs/advanced/skills#writing-your-sites-skill",
        label: "Writing your site's skill",
      },
    ],
    id: "product-documentation-agent-skill",
    image: { src: "/guides/product-documentation-agent-skill.webp" },
    meta: {
      description:
        "Write a SKILL.md from your docs that walks coding agents through your SDK's setup, publish it with your docs site, and test it in a fresh project.",
      title: "How to create an agent skill for your SDK from your docs",
    },
    nextStep: {
      body: "Run it at the root of your docs project, then tighten the draft around the one task you'll test.",
      command: "npx blume skill --claude",
      link: {
        href: "/docs/discoverability/agent-discovery#your-sites-skill",
        label: "Read the skill reference",
      },
      title: "Draft your site's skill",
    },
    prerequisites: [
      "A Blume docs site for your SDK",
      "Node.js 22.12 or later",
      "Claude Code or Codex, signed in",
    ],
    published: "2026-09-27",
    summary:
      "A SKILL.md grounded in your docs that walks coding agents through your SDK's setup, published with your docs site and tested in a fresh project against expected outcomes.",
    title: "Publish a tested agent skill for your SDK",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/discoverability/json-api", label: "JSON API" },
      { href: "/docs/discoverability/markdown", label: "Markdown for agents" },
      { href: "/docs/deployment#set-your-site-url", label: "Site URL" },
    ],
    id: "documentation-json-api-rag",
    image: { src: "/guides/documentation-json-api-rag.webp" },
    meta: {
      description:
        "Ingest your docs into a RAG pipeline from Blume's Markdown and JSON API: sync pages by route, re-embed only what changed, and cite the exact section.",
      title: "How to ingest documentation for RAG and keep source URLs",
    },
    nextStep: {
      body: "Turn on the MCP server so coding agents can search and read your pages directly, without an index of their own.",
      link: {
        href: "/guides/mcp-server-for-documentation",
        label: "Read the MCP server guide",
      },
      title: "Give agents the same docs",
    },
    prerequisites: [
      "A Blume docs site, deployed or running locally",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A sync script that indexes your docs from their JSON API, embeds only changed pages, and drops removed ones, plus a query that cites the exact section each answer came from.",
    title: "Index documentation for RAG without scraping HTML",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/discoverability/markdown", label: "Markdown for agents" },
      { href: "/docs/deployment#server-rendering", label: "Server rendering" },
      {
        href: "/docs/discoverability/agent-discovery",
        label: "Agent discovery",
      },
    ],
    id: "html-markdown-content-negotiation",
    image: { src: "/guides/html-markdown-content-negotiation.webp" },
    meta: {
      description:
        "Serve Markdown to AI agents and HTML to browsers at the same docs URL with Accept: text/markdown, then test the headers, content, links, and CDN caching.",
      title: "How to serve Markdown to AI agents with Accept: text/markdown",
    },
    nextStep: {
      body: "A server build on Vercel or Cloudflare can also host an MCP server, so agents can search your docs and fetch pages as tools.",
      link: {
        href: "/guides/mcp-server-for-documentation",
        label: "Read the MCP server guide",
      },
      title: "Add an MCP server",
    },
    prerequisites: [
      "A Blume project with content pages",
      "A Vercel or Cloudflare account",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Browsers get HTML and agents that send Accept: text/markdown get the page's Markdown at the same URL, checked by a script that tests headers, content, and caching.",
    title: "Serve HTML and Markdown from the same documentation URL",
    topic: "agents",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/discoverability/sitemap-and-robots",
        label: "Sitemap and robots",
      },
      {
        href: "/docs/cli/audit#checking-a-live-deployment",
        label: "Checking a live deployment",
      },
      {
        href: "/docs/discoverability/metadata#per-page-overrides",
        label: "Per-page SEO overrides",
      },
    ],
    id: "ai-search-documentation-crawlability",
    image: { src: "/guides/ai-search-documentation-crawlability.webp" },
    meta: {
      description:
        "Check your documentation's AI search visibility: test robots.txt, CDN bot rules, status codes, and noindex for OAI-SearchBot and Googlebot, and log results.",
      title: "How to check if OAI-SearchBot and Googlebot can reach your docs",
    },
    nextStep: {
      body: "Build the commit you deployed, then point the audit at your domain to catch error responses, noindex headers, and an unreachable robots.txt or sitemap.",
      command: "npx blume audit --url https://docs.acme.example",
      link: {
        href: "/docs/cli/audit#checking-a-live-deployment",
        label: "Read the audit reference",
      },
      title: "Audit your live site",
    },
    prerequisites: [
      "A deployed Blume docs site",
      "curl and Node.js 22.12 or later",
      "Access to your CDN or host's bot settings",
      "Search Console access, for the Google checks",
    ],
    published: "2026-09-27",
    summary:
      "A repeatable check of robots.txt, CDN bot rules, status codes, and indexing signals for the crawlers behind ChatGPT search and Google's AI features.",
    title: "Check whether AI search crawlers can access your docs",
    topic: "seo",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/configuration/analytics", label: "Analytics" },
      { href: "/docs/configuration#page-feedback", label: "Page feedback" },
      {
        href: "/docs/discoverability/metadata#your-own-tags",
        label: "Verification tags",
      },
      {
        href: "/docs/discoverability/sitemap-and-robots",
        label: "Sitemap and robots",
      },
    ],
    id: "measure-ai-search-documentation",
    image: { src: "/guides/measure-ai-search-documentation.webp" },
    meta: {
      description:
        "Measure AI search traffic to your docs: ChatGPT referrals in analytics, Bing's AI citation report, Search Console clicks, and a dated GEO baseline.",
      title: "How to measure AI search traffic to your documentation",
    },
    nextStep: {
      body: "Ship the analytics config, verify both search consoles, and fill the worksheet once a full month of data is in, before you change anything else.",
      link: {
        href: "/docs/configuration/analytics",
        label: "Read the analytics docs",
      },
      title: "Take your first baseline",
    },
    prerequisites: [
      "A Blume docs site deployed on your own domain",
      "A Google Analytics 4 property",
      "Permission to verify the domain in Search Console and Bing Webmaster Tools",
    ],
    published: "2026-09-27",
    summary:
      "Track AI citations, assistant referrals, and the reader actions that follow as separate numbers, with a dated baseline you compare every month.",
    title: "Measure AI search referrals and citations for your docs",
    topic: "seo",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/cli/audit", label: "Audit" },
      { href: "/docs/discoverability/metadata", label: "Metadata" },
      {
        href: "/docs/discoverability/sitemap-and-robots",
        label: "Sitemap and robots",
      },
      { href: "/docs/deployment#redirects", label: "Redirects" },
    ],
    id: "documentation-seo-audit-ci",
    image: { src: "/guides/documentation-seo-audit-ci.webp" },
    meta: {
      description:
        "Run a documentation SEO audit in CI that catches broken canonicals, stale sitemaps, bad redirects, and thin metadata in your static site before deploy.",
      title: "How to run a documentation SEO audit in CI before you deploy",
    },
    nextStep: {
      body: "Build your docs and run the audit locally to see where you stand before you pick a gate for CI.",
      command: "npx blume build && npx blume audit",
      link: { href: "/docs/cli/audit", label: "Read the audit reference" },
      title: "Audit your own build",
    },
    prerequisites: [
      "Node.js 22.12 or later",
      "A GitHub repository for the CI job",
      "Your docs site's public URL",
    ],
    published: "2026-09-27",
    summary:
      "A test project with planted SEO failures, an audit that points each one at its source line, the fixes, and a GitHub Actions job that blocks a bad deploy.",
    title: "Add a technical SEO check to your documentation build",
    topic: "seo",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/cli/audit", label: "Audit" },
      {
        href: "/docs/discoverability/sitemap-and-robots",
        label: "Sitemap and robots",
      },
      {
        href: "/docs/discoverability/metadata#per-page-overrides",
        label: "Per-page SEO overrides",
      },
      {
        href: "/docs/deployment#set-your-site-url",
        label: "Set your site URL",
      },
    ],
    id: "documentation-not-indexed",
    image: { src: "/guides/documentation-not-indexed.webp" },
    meta: {
      description:
        "Docs pages discovered but not indexed? Read the Search Console reason, trace robots.txt, noindex, and canonical causes with blume audit, and verify fixes.",
      title: "How to diagnose documentation pages not indexed by Google",
    },
    nextStep: {
      body: "After your next build, run the checks this guide leans on. Add --url with your domain to include the live site.",
      command: "npx blume audit --only indexability,sitemap,robots,links",
      link: {
        href: "/docs/cli/audit#checking-a-live-deployment",
        label: "Read the audit reference",
      },
      title: "Audit your build",
    },
    prerequisites: [
      "A Blume site deployed on its own domain",
      "Access to its Search Console property",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "Read the reason Search Console gives, trace robots.txt, noindex, and canonical causes to the file behind them, and confirm each fix on the live site.",
    title: "Find out why Google isn't indexing your docs pages",
    topic: "seo",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/deployment#redirects", label: "Redirects" },
      {
        href: "/docs/deployment#pattern-redirects",
        label: "Pattern redirects",
      },
      { href: "/docs/cli/audit#redirects", label: "Audit redirect checks" },
      { href: "/docs/content#group-folders", label: "Group folders" },
    ],
    id: "documentation-url-migration-redirects",
    image: { src: "/guides/documentation-url-migration-redirects.webp" },
    meta: {
      description:
        "Plan documentation migration redirects: map every old URL, add exact and pattern redirects, verify status codes on the live host, and move docs to a new domain.",
      title: "How to move docs to a new domain or URL structure with redirects",
    },
    nextStep: {
      body: "After a build, run the audit's redirect and link checks, then run the script above against your live host.",
      command: "npx blume audit --only redirects,links",
      link: { href: "/docs/cli/audit", label: "Read the audit docs" },
      title: "Audit your redirects",
    },
    prerequisites: [
      "A deployed Blume docs site",
      "Node.js 22.12 or later",
      "curl and a bash shell",
      "Access to your host's domain settings, for a domain move",
    ],
    published: "2026-09-27",
    summary:
      "Map every old URL to its new page, serve real HTTP redirects from your host, check each one on the live site, and keep a way back if the move goes wrong.",
    title: "Move documentation URLs without breaking old links",
    topic: "seo",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/i18n#fallbacks", label: "Locale fallbacks" },
      { href: "/docs/cli/audit", label: "Audit" },
      { href: "/docs/discoverability/metadata", label: "Metadata" },
      { href: "/docs/deployment#set-your-site-url", label: "Site URL" },
    ],
    id: "multilingual-documentation-hreflang",
    image: { src: "/guides/multilingual-documentation-hreflang.webp" },
    meta: {
      description:
        "Map each locale URL to its canonical and hreflang tags, keep untranslated fallback pages from competing, and fix a translation that canonicalizes elsewhere.",
      title: "How to fix hreflang and canonical URLs on multilingual docs",
    },
    nextStep: {
      body: "Build your site, then run the language, canonical, and sitemap checks on what it produced.",
      command: "npx blume audit --only i18n,indexability,sitemap",
      link: { href: "/docs/cli/audit", label: "Read the audit docs" },
      title: "Audit your translated pages",
    },
    prerequisites: [
      "Node.js 22.12 or later",
      "A Blume project, or a folder to start one in",
      "Your docs site's public URL",
    ],
    published: "2026-09-27",
    summary:
      "A two-language docs site where every translation is canonical to itself and linked by hreflang, untranslated pages defer to the original, and an audit proves it.",
    title: "Fix hreflang and canonical URLs on multilingual docs",
    topic: "seo",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/configuration/search#pagefind",
        label: "Pagefind adapter",
      },
      {
        href: "/docs/configuration/search#excluding-pages",
        label: "Excluding pages",
      },
      { href: "/docs/content/i18n#search", label: "Search across languages" },
      {
        href: "/docs/content/versioning#search",
        label: "Search across versions",
      },
    ],
    id: "pagefind-documentation-search",
    image: { src: "/guides/pagefind-documentation-search.webp" },
    meta: {
      description:
        "Add Pagefind documentation search to a static docs site with no search server, then test headings, languages, long pages, and exclusions with a script.",
      title: "How to add Pagefind search to static documentation",
    },
    nextStep: {
      body: "Set search to pagefind() in your config, build, and run the query checklist against blume preview.",
      command: "npx blume build",
      link: {
        href: "/docs/configuration/search#pagefind",
        label: "Read the Pagefind docs",
      },
      title: "Switch your site to Pagefind",
    },
    prerequisites: [
      "Node.js 22.12 or later",
      "A Blume project, or a folder to start one in",
    ],
    published: "2026-09-27",
    summary:
      "Switch your docs search to Pagefind, build the index with the site, and check headings, languages, long pages, and exclusions with a query script you rerun on every build.",
    title: "Add Pagefind search to a static documentation site",
    topic: "search",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/configuration/search#typesense",
        label: "Typesense adapter",
      },
      { href: "/docs/configuration/search#ranking", label: "Search ranking" },
      {
        href: "/docs/deployment#environment-variables",
        label: "Environment variables",
      },
    ],
    id: "typesense-documentation-search",
    image: { src: "/guides/typesense-documentation-search.webp" },
    meta: {
      description:
        "Self-host documentation search with Typesense: run the server, split sync and search-only keys, rebuild the index on every build, and keep your synonyms.",
      title: "How to self-host documentation search with Typesense",
    },
    nextStep: {
      body: "Record searches that return nothing, then write or retag the pages they point to.",
      link: {
        href: "/guides/documentation-search-analytics",
        label: "Read the search analytics guide",
      },
      title: "Find what readers can't find",
    },
    prerequisites: [
      "A Blume docs project",
      "Docker, locally and on a server with a domain",
      "curl and jq",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A Typesense server you run, scoped keys for your build and your readers, a docs collection rebuilt on every production build, and synonyms relinked after each sync.",
    title: "Self-host documentation search with Typesense",
    topic: "search",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/configuration/search#search-analytics",
        label: "Search analytics",
      },
      { href: "/docs/configuration/search#ranking", label: "Search ranking" },
      { href: "/docs/configuration/analytics", label: "Analytics adapters" },
      { href: "/docs/configuration/consent", label: "Cookie consent" },
    ],
    id: "documentation-search-analytics",
    image: { src: "/guides/documentation-search-analytics.webp" },
    meta: {
      description:
        "Use documentation search analytics to list zero-result searches in your docs, tell content gaps from wording mismatches, fix them, and rerun the same searches.",
      title: "How to find content gaps with documentation search analytics",
    },
    nextStep: {
      body: "Start the dev server, listen for blume:track in the browser console, and search for a word your docs don't use.",
      command: "npx blume dev",
      link: {
        href: "/docs/configuration/search#search-analytics",
        label: "Read the search analytics docs",
      },
      title: "Watch your first searches",
    },
    prerequisites: [
      "A Blume docs site",
      "PostHog, or another analytics provider that keeps event properties",
      "A privacy policy that covers analytics",
    ],
    published: "2026-09-27",
    summary:
      "A saved report of the searches your docs can't answer, sorted into pages to write and words to add, with a keyword fix checked before and after.",
    title: "Find missing documentation from searches with no results",
    topic: "search",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/configuration/search", label: "Search adapters" },
      {
        href: "/docs/configuration/search#whats-indexed",
        label: "What's indexed",
      },
      {
        href: "/docs/configuration/assistant#grounding",
        label: "Assistant grounding",
      },
    ],
    id: "choose-documentation-search",
    image: { src: "/guides/choose-documentation-search.webp" },
    meta: {
      description:
        "Local vs hosted vs semantic docs search: run one fixed query set through each candidate's real search dialog, compare what it finds, and pick what fits.",
      title: "How to choose the best search for your documentation",
    },
    nextStep: {
      body: "Pull the searches that found nothing from your analytics, then run them through your current search before you change anything.",
      link: {
        href: "/guides/documentation-search-analytics",
        label: "Read the search analytics guide",
      },
      title: "Find your first queries",
    },
    prerequisites: [
      "A Blume docs project",
      "Node.js 22.12 or later",
      "Real queries from your readers, like zero-result searches",
      "An account with each hosted provider you want to test",
    ],
    published: "2026-09-27",
    summary:
      "Run one fixed query set through local, hosted, and semantic search, compare what each finds and what it takes to run, and keep the engine your docs need.",
    title: "Choose local, hosted or semantic search for your docs",
    topic: "search",
  },
  {
    author: "hayden",
    docs: [
      {
        href: "/docs/configuration/search#non-latin-scripts",
        label: "Non-Latin scripts",
      },
      { href: "/docs/configuration/search#pagefind", label: "Pagefind" },
      { href: "/docs/content/i18n", label: "Internationalization" },
    ],
    id: "cjk-documentation-search",
    image: { src: "/guides/cjk-documentation-search.webp" },
    meta: {
      description:
        "How Blume's docs search handles Chinese, Japanese and Korean words, and how to test CJK full-text search with Orama, Pagefind, or Typesense.",
      title: "How to fix Chinese, Japanese and Korean documentation search",
    },
    nextStep: {
      body: "With an analytics adapter on, every query that finds nothing is recorded with results: 0, so the CJK terms your test list missed show up.",
      link: {
        href: "/guides/documentation-search-analytics",
        label: "Read the search analytics guide",
      },
      title: "Track searches with no results",
    },
    prerequisites: [
      "A Blume project, or an empty folder for the test corpus",
      "Node.js 22.12 or later",
      "A native speaker to review the test queries",
    ],
    published: "2026-09-27",
    summary:
      "A four-language test corpus, a query list to check it against, and a search setup that finds Chinese, Japanese and Korean words, with results for each engine.",
    title: "Make docs search work in Chinese, Japanese and Korean",
    topic: "search",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/cli/validate", label: "Validate" },
      { href: "/docs/cli/audit", label: "Audit" },
      { href: "/docs/content/syntax#custom-anchors", label: "Custom anchors" },
    ],
    id: "markdown-link-checking-ci",
    image: { src: "/guides/markdown-link-checking-ci.webp" },
    meta: {
      description:
        "Fail a pull request when it breaks a docs link or heading anchor: check Markdown links in CI with GitHub Actions and probe external URLs on a schedule.",
      title: "How to check for broken Markdown links in CI with GitHub Actions",
    },
    nextStep: {
      body: "Run it at the root of your docs project to see what the pull request check would report today.",
      command: "npx blume validate --strict",
      link: {
        href: "/docs/cli/validate",
        label: "Read the validate reference",
      },
      title: "Check your links now",
    },
    prerequisites: [
      "A Blume docs project in a GitHub repository",
      "Node.js 22.12 or later",
      "Access to the repository's branch protection settings",
    ],
    published: "2026-09-27",
    summary:
      "A pull request check that fails on broken docs links and heading anchors and annotates each one on its line, plus a weekly job that probes external URLs.",
    title: "Catch broken Markdown links in GitHub Actions",
    topic: "quality",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/islands", label: "Islands" },
      {
        href: "/docs/content/components#component",
        label: "Component previews",
      },
      { href: "/docs/configuration/customization", label: "Customization" },
      {
        href: "/docs/discoverability/markdown#custom-component-serializers",
        label: "Markdown for your components",
      },
    ],
    id: "react-examples-mdx-documentation",
    image: { src: "/guides/react-examples-mdx-documentation.webp" },
    meta: {
      description:
        "Show an interactive React component beside its usage code in MDX docs: register an island, choose how it hydrates, and test it from the keyboard.",
      title:
        "How to add interactive React component demos to MDX documentation",
    },
    nextStep: {
      body: "Save a React component in islands/ and use it by name in any MDX page, with no import.",
      command: "npx blume dev",
      link: { href: "/docs/content/islands", label: "Read the islands docs" },
      title: "Add your first island",
    },
    prerequisites: [
      "A Blume docs project",
      "A React component to document",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A live component demo beside the code that uses it, with a props table, a text version for readers and agents that can't run it, and a keyboard test on the production build.",
    title: "Add live React component demos to your MDX docs",
    topic: "writing",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/navigation#tabs", label: "Navigation tabs" },
      { href: "/docs/content/navigation#selectors", label: "Selectors" },
      {
        href: "/docs/references/openapi#multiple-specs",
        label: "Multiple OpenAPI specs",
      },
      { href: "/docs/content/includes#props", label: "Include props" },
    ],
    id: "multi-product-developer-portal",
    image: { src: "/guides/multi-product-developer-portal.webp" },
    meta: {
      description:
        "Organize developer portal documentation for several products: a URL prefix, tab, and API reference per product, shared pages, and search that names the product.",
      title: "How to build a multi-product documentation portal for developers",
    },
    nextStep: {
      body: "Run doctor to catch duplicate routes and unknown icons, then tune each product's reference with the multiple-specs guide.",
      command: "npx blume doctor",
      link: {
        href: "/guides/multiple-openapi-specs-documentation",
        label: "Read the multiple-specs guide",
      },
      title: "Check your portal's routes",
    },
    prerequisites: [
      "A Blume project (npx blume init)",
      "An OpenAPI spec for each product's API",
      "Node.js 22.12 or later",
    ],
    published: "2026-09-27",
    summary:
      "A two-product developer portal where each product has its own tab, sidebar, quickstart, and API reference, shared pages stay one click away, and search results name the product.",
    title: "Build a developer portal for multiple products",
    topic: "writing",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/configuration#page-feedback", label: "Page feedback" },
      {
        href: "/docs/configuration/analytics#custom-events",
        label: "Analytics events",
      },
      { href: "/docs/configuration/consent", label: "Cookie consent" },
    ],
    id: "documentation-feedback-analytics",
    image: { src: "/guides/documentation-feedback-analytics.webp" },
    meta: {
      description:
        "Turn on the documentation feedback widget, send ratings and comments to PostHog, rank pages by helpfulness, and turn what readers say into fixes.",
      title: "How to collect documentation feedback and find confusing pages",
    },
    nextStep: {
      body: "Search sends its queries through the same adapter. Filter on searches with no results to find the pages your docs don't have yet.",
      link: {
        href: "/guides/documentation-search-analytics",
        label: "Read the search analytics guide",
      },
      title: "Find what readers search for and miss",
    },
    prerequisites: [
      "A Blume docs project",
      "A PostHog project and its project API key",
      "A deployed site, since analytics only loads in production builds",
    ],
    published: "2026-09-27",
    summary:
      "A page-level helpfulness report in PostHog, the reader comments behind your weakest pages, and a pull request that records why each fix was made.",
    title: "Collect documentation feedback and turn it into fixes",
    topic: "quality",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/configuration/export", label: "Export" },
      {
        href: "/docs/content/syntax#long-lines-and-long-blocks",
        label: "Long code lines",
      },
      { href: "/docs/configuration/theming#themecss", label: "theme.css" },
    ],
    id: "documentation-pdf-epub-export",
    image: { src: "/guides/documentation-pdf-epub-export.webp" },
    meta: {
      description:
        "Let readers save a Markdown docs page as a PDF or EPUB: turn on Blume's Export action, test both files, and fix code, tabs, and diagrams that don't carry over.",
      title: "How to add documentation PDF downloads and EPUB export",
    },
    nextStep: {
      body: "Add export: true to blume.config.ts, then export your longest page in both formats and check it against the checklist.",
      link: {
        href: "/docs/configuration/export",
        label: "Read the export docs",
      },
      title: "Turn on page export",
    },
    prerequisites: [
      "A Blume docs site",
      "Node.js 22.12 or later",
      "Chrome or Firefox, plus Apple Books or calibre to open EPUB files",
    ],
    published: "2026-09-27",
    summary:
      "Readers can save any docs page as a PDF or an EPUB, and you know what each format keeps, from long code blocks and tabs to images and diagrams.",
    title: "Offer PDF and EPUB downloads of your docs pages",
    topic: "writing",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/content/syntax#diagrams", label: "Mermaid diagrams" },
      {
        href: "/docs/content/includes#including-code-files",
        label: "Including code files",
      },
      {
        href: "/docs/discoverability/markdown#raw-markdown",
        label: "Markdown mirrors",
      },
      { href: "/docs/configuration/export", label: "PDF and EPUB export" },
    ],
    id: "architecture-documentation-mermaid",
    image: { src: "/guides/architecture-documentation-mermaid.webp" },
    meta: {
      description:
        "Keep Markdown architecture diagrams in Git beside the prose: draw Mermaid flowcharts and sequence diagrams, review them as diffs, and publish with Blume.",
      title: "How to write software architecture documentation with Mermaid",
    },
    nextStep: {
      body: "Keep decision records beside the architecture page, so each change to a diagram can point to the decision behind it.",
      link: {
        href: "/guides/engineering-handbook-markdown",
        label: "Read the engineering handbook guide",
      },
      title: "Record why the architecture looks this way",
    },
    prerequisites: [
      "Node.js 22.12 or later",
      "A Blume project with a docs folder",
      "A list of your system's components and how they connect",
    ],
    published: "2026-09-27",
    summary:
      "An architecture page with a component flowchart and a request sequence diagram, kept as Mermaid source in Git, plus text that explains the system wherever diagrams don't render.",
    title: "Create architecture documentation with Mermaid diagrams",
    topic: "writing",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/migrating", label: "Migrating" },
      { href: "/docs/content/meta", label: "Folder meta" },
      {
        href: "/docs/deployment#mount-the-docs-under-a-path",
        label: "Mount under a path",
      },
      { href: "/compare/fumadocs", label: "Blume vs Fumadocs" },
    ],
    id: "migrate-from-fumadocs",
    image: { src: "/guides/migrate-from-fumadocs.webp" },
    meta: {
      description:
        "Migrate from Fumadocs to Blume with a coding agent: meta.json becomes meta.ts, components and icons are rewritten, and your docs stay at /docs.",
      title: "How to migrate from Fumadocs to Blume",
    },
    nextStep: {
      body: "Run it where your docs' package.json lives, on a clean branch, then work through the review above.",
      command: "npx blume migrate fumadocs --claude",
      link: { href: "/docs/migrating", label: "Read the migration reference" },
      title: "Migrate your docs",
    },
    prerequisites: [
      "A Fumadocs site's repository",
      "Node.js 22.12 or later",
      "Claude Code or Codex, signed in",
    ],
    published: "2026-09-27",
    summary:
      "Hand your Fumadocs repository to a coding agent, check its meta.ts and component rewrites, keep your docs at /docs, and deploy with every old URL working.",
    title: "Migrate your docs from Fumadocs",
    topic: "migrate",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/migrating", label: "Migrating" },
      {
        href: "/docs/configuration/customization#layout-slots",
        label: "Layout slots",
      },
      { href: "/docs/deployment#redirects", label: "Redirects" },
      { href: "/compare/starlight", label: "Blume vs Starlight" },
    ],
    id: "migrate-from-starlight",
    image: { src: "/guides/migrate-from-starlight.webp" },
    meta: {
      description:
        "Migrate from Starlight to Blume with a coding agent: keep src/content/docs and your URLs, map the sidebar and overrides, and see what stays custom Astro work.",
      title: "How to migrate from Starlight to Blume",
    },
    nextStep: {
      body: "Run it in the folder that holds your astro.config.mjs, on a clean branch, then work through the review above.",
      command: "npx blume migrate starlight --claude",
      link: { href: "/docs/migrating", label: "Read the migration reference" },
      title: "Migrate your docs",
    },
    prerequisites: [
      "A Starlight site's repository",
      "Node.js 22.12 or later",
      "Claude Code or Codex, signed in",
    ],
    published: "2026-09-27",
    summary:
      "Move a Starlight site to Blume with a coding agent, keep its pages and URLs, and rebuild the overrides and splash pages that stay Astro work.",
    title: "Migrate your docs from Starlight",
    topic: "migrate",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/migrating", label: "Migrating" },
      { href: "/docs/content/meta", label: "Folder meta" },
      { href: "/docs/content/islands", label: "Islands" },
      { href: "/compare/nextra", label: "Blume vs Nextra" },
    ],
    id: "migrate-from-nextra",
    image: { src: "/guides/migrate-from-nextra.webp" },
    meta: {
      description:
        "Migrate from Nextra with a coding agent: turn _meta files into meta.ts, keep nested sidebar order, port React components to islands, and keep every URL.",
      title: "How to migrate from Nextra to Blume",
    },
    nextStep: {
      body: "Run it in the folder whose package.json lists nextra, on a clean branch, then work through the review above.",
      command: "npx blume migrate nextra --claude",
      link: { href: "/docs/migrating", label: "Read the migration reference" },
      title: "Migrate your docs",
    },
    prerequisites: [
      "A Nextra 2, 3, or 4 site's repository, with its lockfile",
      "Node.js 22.12 or later",
      "Claude Code or Codex, signed in",
    ],
    published: "2026-09-27",
    summary:
      "Move a Nextra site's MDX and _meta navigation to Blume with a coding agent, check nested order and React components, and keep every URL working.",
    title: "Migrate your docs from Nextra",
    topic: "migrate",
  },
  {
    author: "hayden",
    docs: [
      { href: "/docs/migrating", label: "Migrating" },
      { href: "/docs/content/syntax", label: "Syntax" },
      { href: "/docs/content/navigation", label: "Navigation" },
      { href: "/docs/deployment#redirects", label: "Redirects" },
    ],
    id: "migrate-from-mkdocs-material",
    image: { src: "/guides/migrate-from-mkdocs-material.webp" },
    meta: {
      description:
        "Migrate from MkDocs Material to Blume: map mkdocs.yml and nav, rewrite admonitions, tabs, and snippets, replace plugins, and keep every old URL working.",
      title: "How to migrate from MkDocs Material to Blume",
    },
    nextStep: {
      body: "Run it at the root of your MkDocs project, on a clean branch. With no MkDocs mappings, the agent inventories the repo first, so point it at the tables above.",
      command: "npx blume migrate --claude",
      link: { href: "/docs/migrating", label: "Read the migration reference" },
      title: "Draft the migration",
    },
    prerequisites: [
      "An MkDocs Material site's repository",
      "Node.js 22.12 or later",
      "Claude Code or Codex, if an agent drafts the first pass",
    ],
    published: "2026-09-27",
    summary:
      "Move an MkDocs Material site's Markdown to Blume, rebuild its nav as folders, rewrite extension syntax, replace its plugins, and check that every old URL still works.",
    title: "Migrate your docs from MkDocs Material",
    topic: "migrate",
  },
];

/** A guide by its id; throws at build time on a typo in a route file. */
export const guideById = (id: string): Guide => {
  const guide = guides.find((entry) => entry.id === id);
  if (!guide) {
    throw new Error(`Unknown guide: ${id}`);
  }
  return guide;
};
