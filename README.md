# Blume

Open-source, markdown-first documentation powered by Astro and Vite.

> Mintlify's authoring DX, Astro/Vite performance, and full open-source ownership.

Drop Markdown or MDX into a folder, run `blume dev`, and get a production-grade
docs site with navigation, search, theming, and a rich component library — no
app boilerplate. Blume generates and drives a hidden Astro project for you, and
you can `blume eject` to a normal Astro app whenever you want full control.

## Quickstart

```bash
bun add blume
blume init
blume dev
```

Build for production (static by default):

```bash
blume build
```

## Features

- **Zero-boilerplate authoring** — a folder of docs is a complete project.
- **Static-first** — fast, cacheable output; opt into server features.
- **Astro-first theme** — the core theme ships no client JavaScript.
- **Components** — callouts, cards, steps, tabs, accordions, badges, file trees,
  and API-reference blocks, usable in MDX with no imports.
- **Local search** — works in dev and production via Orama (Pagefind opt-in for large sites), no hosted service.
- **Navigation** — inferred from files, refined with `meta.ts` or config.
- **Customization** — component overrides, React islands, custom pages, theme
  tokens and `theme.css`, and a source-component registry (`blume add`).
- **API docs** — `blume import openapi` generates editable reference pages.
- **OG images** — per-page Open Graph images rendered at build with Takumi.
- **AI** — `llms.txt`/`llms-full.txt` and an optional Ask AI assistant.
- **Migration** — `blume migrate mintlify | starlight | fumadocs`.
- **Eject** — `blume eject` produces a standalone Astro project.

## CLI

| Command                       | Description                                      |
| ----------------------------- | ------------------------------------------------ |
| `blume init`                  | Scaffold a minimal project.                      |
| `blume dev`                   | Start the dev server with hot reload.            |
| `blume build`                 | Build the static (or server) site.               |
| `blume preview`               | Preview the last build.                          |
| `blume add <item>`            | Install a source component from the registry.    |
| `blume import openapi <spec>` | Generate API pages from an OpenAPI spec.         |
| `blume migrate <tool>`        | Migrate from another docs tool.                  |
| `blume eject`                 | Promote the runtime into a standalone Astro app. |
| `blume doctor`                | Diagnose config and content problems.            |

## Repository layout

```txt
packages/blume   The published package: CLI, core, Astro runtime, components,
                 theme, search, registry, migrate, openapi
docs             Blume's own documentation, built with Blume
```

## Compatibility

| Tool             | Supported                         |
| ---------------- | --------------------------------- |
| Node             | 20+                               |
| Astro            | 5.x                               |
| Package managers | Bun, pnpm, npm, yarn              |
| Adapters         | Vercel, Node, Netlify, Cloudflare |

## Development

```bash
bun install
bun run check       # lint + format (Ultracite)
bun run typecheck
bun run test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for architecture and conventions.

## License

MIT
