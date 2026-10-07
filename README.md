# Blume

[![npm downloads](https://img.shields.io/npm/dm/blume.svg)](https://www.npmjs.com/package/blume) [![Socket Badge](https://badge.socket.dev/npm/package/blume/latest)](https://socket.dev/npm/package/blume/overview/latest) ![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/haydenbleasel/blume?utm_source=oss&utm_medium=github&utm_campaign=haydenbleasel%2Fblume&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

**The open-source docs framework for humans and agents.** Fast, AI-ready, and zero-config. Free and open source, forever.

Drop Markdown or MDX into a folder, start the dev server, and get a production-grade docs site — navigation, search, theming, Open Graph images, and a rich component library — with no app boilerplate to write or maintain. Blume generates and drives a hidden Astro project for you; run `npx blume eject` to get a standalone Astro app whenever you want full control.

**[Documentation](https://useblume.dev)** · [Quickstart](https://useblume.dev/docs/quickstart) · [Components](https://useblume.dev/docs/content/components) · [CLI](https://useblume.dev/docs/cli)

## Quickstart

Blume needs **Node.js 22.19 or newer** and a content folder with at least one `.md`/`.mdx` file — there's nothing else to set up.

```bash
npx blume init
```

It scaffolds `docs/index.mdx` and `blume.config.ts`, adds `dev` and `build` scripts to a new `package.json`, and installs dependencies. Run the dev server with hot reload:

```bash
npm run dev
```

Build static HTML, with a local search index, into `dist/`:

```bash
npm run build
```

In a project that already has a `package.json`, `blume init` leaves it alone: add `"dev": "blume dev"` and `"build": "blume build"` to its scripts, or run `npx blume dev`. Blume works with any package manager and never requires you to set up Astro or Tailwind yourself.

Moving from another docs framework? `npx blume migrate` hands a Mintlify, Docusaurus, GitBook, MkDocs, ReadMe, or other docs site to Claude Code or Codex — see [Migrate to Blume](https://useblume.dev/docs/migrating). On Blume 1, run `npx blume@latest upgrade` — see [Upgrade to Blume 2](https://useblume.dev/docs/upgrading).

## Features

- **Zero-config, even the template** — a folder of docs is a complete project. No starter to clone, no framework to learn. Configuration is opt-in, one file at a time.
- **Fast by default** — static HTML on Astro and Vite; the core theme ships no client framework JS so pages score well on Core Web Vitals out of the box.
- **Type-safe config** — `blume.config.ts` and every `meta.ts` are real TypeScript, validated by a schema and authored with `defineConfig` / `defineMeta`, so your editor catches mistakes before a build.
- **Components, no imports** — cards, columns, steps, tabs, accordions, badges, code groups, frames, file trees, type tables, live component previews, diffs, and more, usable in any MDX page.
- **Local search** — Orama runs in dev and production with no hosted service; FlexSearch, Pagefind, Algolia, Typesense, Orama Cloud, and Mixedbread are one adapter away (`search: pagefind()` from `blume/search`).
- **AI-ready** — `llms.txt` / `llms-full.txt`, raw Markdown at any `.md` URL, a JSON docs API, Copy as Markdown, Open in chat, an optional in-page assistant, and a hosted MCP server so coding agents can search and read your docs directly.
- **Agent skills** — Blume ships [agent skills](https://useblume.dev/docs/advanced/skills) that teach a coding agent to scaffold, write, and maintain your docs site.
- **Content sources** — mix local files with remote MDX, GitHub Releases, Notion, Sanity, Contentful, Payload, Strapi, or any custom backend into a single site.
- **Internationalization** — drop translated files into place for locale-aware routing, per-language navigation, translated UI, and SEO.
- **SEO** — metadata, Open Graph images (rendered at build with Takumi), sitemap, `robots.txt`, RSS feeds, and JSON-LD, built in.
- **API references** — render OpenAPI, AsyncAPI, and GraphQL specs as native reference pages (one per operation, with schemas, auth, and a request playground) with `openapi()`, `asyncapi()`, and `graphql()` from `blume/reference`, or embed Scalar's UI with `scalar()`.
- **Export** — let readers download any page as a PDF or EPUB, entirely client-side, so static builds stay static.
- **Customization** — component overrides, React islands, custom pages, Tailwind v4 theme tokens and `theme.css`, and a source-component registry (`blume add`).
- **Eject** — `npx blume eject` produces a standalone Astro project that still uses the `blume` package.

## CLI

| Command | Description |
| --- | --- |
| `blume init [dir]` | Scaffold a project (interactive by default). |
| `blume dev` | Start the dev server with hot reload. |
| `blume build` | Build the static (or server) site. |
| `blume preview` | Preview the last build. |
| `blume add <item>` | Install a source component from the registry. |
| `blume sync` | Re-fetch remote content sources and regenerate. |
| `blume eject` | Promote the runtime into a standalone Astro app. |
| `blume check` | Type-check the docs site with `astro check`. |
| `blume validate` | Validate internal, anchor, asset, and external links. |
| `blume doctor` | Diagnose config and content problems. |
| `blume audit` | Audit the built site for SEO and health issues. |
| `blume eval` | Test the docs: an agent answers your questions using only the documentation. |
| `blume translate` | Translate docs into the configured locales with a local agent CLI. |
| `blume version [id]` | Freeze the current docs as an archived version (no id lists configured versions). |
| `blume migrate [source]` | Move a Mintlify, Docusaurus, GitBook, MkDocs, ReadMe, or other docs site to Blume with Claude Code or Codex. |
| `blume upgrade` | Move to a new major: bump `blume`, then list the config changes left or hand them to Claude Code or Codex. |

Run them through your package manager (`npx blume <command>`) or a `package.json` script. See the [CLI reference](https://useblume.dev/docs/cli) for every flag.

## How it works

The Blume CLI loads `blume.config.ts`, scans your content into a graph, and generates a hidden Astro project under `.blume/` that it drives for dev and build. Astro renders through a catch-all page that imports Blume's shipped components, the generated data, and your overrides. `.blume/` is regenerated on each run — only changed files are written, so hot reload stays fast — until you `blume eject` and own it.

## Deployment

`blume build` outputs static HTML to `dist/` — deploy to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages, S3 + CloudFront, or any CDN). For request-time features like the assistant or the MCP server, name a host adapter from `blume/deploy` in `blume.config.ts`, which switches the build to server output:

```ts
import { defineConfig } from "blume";
import { vercel } from "blume/deploy";

export default defineConfig({
  deployment: vercel(),
});
```

| Adapter        | Use for                              |
| -------------- | ------------------------------------ |
| `vercel()`     | Vercel                               |
| `netlify()`    | Netlify Functions                    |
| `node()`       | Self-hosted Node servers, containers |
| `cloudflare()` | Cloudflare Workers and Pages         |

On Vercel, Netlify, and Cloudflare Pages the site URL is detected automatically. The adapter never is: name it in `blume.config.ts`.

## Compatibility

| Requirement      | Supported                         |
| ---------------- | --------------------------------- |
| Node             | 22.19+                            |
| Package managers | Bun, pnpm, npm, yarn              |
| Adapters         | Vercel, Netlify, Node, Cloudflare |

## Development

This repository is a monorepo: the published package lives in `packages/blume`, and `apps/docs` is Blume's own documentation, built with Blume.

```bash
bun install
bun run check       # lint + format (Ultracite)
bun run typecheck
bun run test
```

See [CONTRIBUTING.md](https://github.com/haydenbleasel/blume/blob/main/.github/CONTRIBUTING.md) for architecture and conventions.

## License

[MIT](./LICENSE) © Hayden Bleasel
