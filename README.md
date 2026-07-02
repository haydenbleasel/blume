# Blume

[![npm version](https://img.shields.io/npm/v/blume.svg)](https://www.npmjs.com/package/blume) [![npm downloads](https://img.shields.io/npm/dm/blume.svg)](https://www.npmjs.com/package/blume) [![license](https://img.shields.io/npm/l/blume.svg)](./LICENSE) [![node](https://img.shields.io/node/v/blume.svg)](https://nodejs.org)

**Documentation for everything you build.** Fast, AI-ready, and zero-config. Drop Markdown into a folder and ship a production-grade docs site, no app boilerplate to write or maintain. Free and open source, forever.

Drop Markdown or MDX into a folder, run `blume dev`, and get a production-grade docs site — navigation, search, theming, Open Graph images, and a rich component library — with no app boilerplate to write or maintain. Blume generates and drives a hidden Astro project for you; run `blume eject` to a standalone Astro app whenever you want full control.

**[Documentation](https://useblume.dev)** · [Quickstart](https://useblume.dev/docs/quickstart) · [Components](https://useblume.dev/docs/content/components) · [CLI](https://useblume.dev/docs/reference/cli)

## Quickstart

Blume needs **Node.js 22.12 or newer** and a content folder with at least one `.md`/`.mdx` file — there's nothing else to set up.

```bash
npx blume init
```

Run the dev server with hot reload:

```bash
blume dev
```

Build static HTML, with a local search index, into `dist/`:

```bash
blume build
```

Blume works with any package manager and never requires you to set up Astro or Tailwind yourself.

## Features

- **Zero-config, even the template** — a folder of docs is a complete project. No starter to clone, no framework to learn. Configuration is opt-in, one file at a time.
- **Fast by default** — static HTML on Astro and Vite; the core theme is React-free and ships **zero client JavaScript**, so pages score well on Core Web Vitals out of the box.
- **Type-safe config** — `blume.config.ts` and every `meta.ts` are real TypeScript, validated by a schema and authored with `defineConfig` / `defineMeta`, so your editor catches mistakes before a build.
- **Components, no imports** — cards, columns, steps, tabs, accordions, badges, code groups, frames, file trees, type tables, live component previews, diffs, and more, usable in any MDX page.
- **Local search** — Orama runs in dev and production with no hosted service; FlexSearch, Pagefind, Algolia, Typesense, Orama Cloud, and Mixedbread are one setting away.
- **AI-ready** — `llms.txt` / `llms-full.txt`, raw Markdown at any `.md` URL, Copy as Markdown, Open in chat, an optional Ask AI assistant, and a hosted MCP server so coding agents can search and read your docs directly.
- **Content sources** — mix local files with remote MDX, GitHub Releases, Notion, Sanity, or any custom backend into a single site.
- **SEO** — metadata, Open Graph images (rendered at build with Takumi), sitemap, `robots.txt`, RSS feeds, and JSON-LD, built in.
- **API reference** — render an OpenAPI or AsyncAPI spec as an interactive reference (schemas, auth, request playground) via Scalar.
- **Customization** — component overrides, React islands, custom pages, Tailwind v4 theme tokens and `theme.css`, and a source-component registry (`blume add`).
- **Migration** — `blume migrate mintlify | starlight | nextra | fumadocs`.
- **Eject** — `blume eject` produces a standalone Astro project that still uses the `blume` package.

## CLI

| Command | Description |
| --- | --- |
| `blume init` | Scaffold a minimal project. |
| `blume dev` | Start the dev server with hot reload. |
| `blume build` | Build the static (or server) site. |
| `blume preview` | Preview the last build. |
| `blume add <item>` | Install a source component from the registry. |
| `blume migrate <tool>` | Migrate from Mintlify, Starlight, Nextra, or Fumadocs. |
| `blume sync` | Re-fetch remote content sources and regenerate. |
| `blume eject` | Promote the runtime into a standalone Astro app. |
| `blume validate` | Validate links across your content. |
| `blume doctor` | Diagnose config and content problems. |

See the [CLI reference](https://useblume.dev/docs/reference/cli) for every flag.

## How it works

The Blume CLI loads `blume.config.ts`, scans your content into a graph, and generates a hidden Astro project under `.blume/` that it drives for dev and build. Astro renders through a catch-all page that imports Blume's shipped components, the generated data, and your overrides. `.blume/` is regenerated on each run — only changed files are written, so hot reload stays fast — until you `blume eject` and own it.

## Deployment

`blume build` outputs static HTML to `dist/` — deploy to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages, S3 + CloudFront, or any CDN). For request-time features like Ask AI or the MCP server, switch to server output and pick an adapter:

| Adapter      | Use for                              |
| ------------ | ------------------------------------ |
| `vercel`     | Vercel                               |
| `netlify`    | Netlify Functions                    |
| `node`       | Self-hosted Node servers, containers |
| `cloudflare` | Cloudflare Workers and Pages         |

On Vercel, Netlify, and Cloudflare Pages the matching adapter and site URL are detected automatically.

## Compatibility

| Requirement      | Supported                         |
| ---------------- | --------------------------------- |
| Node             | 22.12+                            |
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

See [CONTRIBUTING.md](./CONTRIBUTING.md) for architecture and conventions.

## License

[MIT](./LICENSE) © Hayden Bleasel
