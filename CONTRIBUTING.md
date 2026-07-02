# Contributing to Blume

Thanks for your interest in Blume! This guide covers the architecture and the day-to-day workflow.

## Prerequisites

- Node.js 20+
- Bun 1.3+

```bash
bun install
```

## Workflow

```bash
bun run check       # Ultracite lint + format check
bun run fix         # auto-fix lint + format
bun run typecheck   # tsc --noEmit across packages
bun run test        # Vitest
```

Run the docs site against your local build:

```bash
cd docs
bun ../packages/blume/bin/blume.mjs dev
```

## Architecture

Blume ships as a single published package, `packages/blume`, with internal modules under `src/`:

| Module | Responsibility |
| --- | --- |
| `cli` | `blume` command entrypoint and subcommands |
| `core` | Config, content discovery, graph, navigation, manifest, diagnostics |
| `astro` | Generated runtime, templates, integration, page discovery |
| `components` | Default Astro/React components and layout |
| `theme` | CSS tokens, base/component styles, icon set, palette |
| `search` | Pagefind index build |
| `registry` | `blume add` registry and `blume eject` |
| `migrate` | Mintlify/Starlight/Fumadocs migrators |
| `openapi` | OpenAPI import |
| `ai` | `llms.txt` generation |

### Runtime model

The CLI loads config, scans content into a graph, and writes a hidden Astro project to `.blume/`. Generated files are owned by Blume and recreated on each run; only changed files are rewritten so Vite HMR stays fast. `.blume/` is safe to delete.

The generated catch-all page imports shipped components from `blume/...`, the generated data module, and user overrides. `blume eject` regenerates the same files with project-relative paths into your project and removes `.blume/`.

## Conventions

- Components are styled with Tailwind v4 utilities (via `@tailwindcss/vite` in the generated runtime) — no hand-written CSS files. Design tokens live as `--blume-*` variables mapped into Tailwind's theme; the typography plugin styles MDX content (`prose`). Users never configure Tailwind themselves.
- Code style is enforced by [Ultracite](https://github.com/haydenbleasel/ultracite) (oxlint + oxfmt). Use arrow function expressions, sorted object keys, and `u`-flag regular expressions with named groups.
- `.astro` files are not linted by oxlint; Astro components use PascalCase.
- Generated runtime files (`.blume/`) and the `plan/` spec are excluded from linting and formatting.

## Releases

Releases use [Changesets](https://github.com/changesets/changesets):

```bash
bunx changeset          # describe your change
```

Merging a changeset to `main` opens a release PR; merging that publishes.
