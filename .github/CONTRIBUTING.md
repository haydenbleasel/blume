# Contributing to Blume

Thanks for your interest in Blume! This guide covers the architecture and the day-to-day workflow.

The repository is a Bun workspace monorepo: `packages/blume` is the published package, `apps/docs` is Blume's own documentation site (built with Blume), and `packages/video` is a private Remotion project for marketing assets.

## Prerequisites

- Node.js 22.12+
- Bun 1.4.0+

```bash
bun install
```

## Workflow

```bash
bun run check          # Ultracite lint + format check
bun run fix            # auto-fix lint + format
bun run typecheck      # tsc --noEmit across packages
bun run test           # bun test
bun run test:coverage  # bun test --coverage
```

Coverage is gated at 98% lines and functions, enforced **per file** and only under `test:coverage` — a plain `bun test` run will not fail on it.

Run the docs site against your local build. `apps/docs` depends on the workspace copy of `blume`, so its scripts already point at your working tree:

```bash
cd apps/docs
bun run dev
```

CI (`.github/workflows/ci.yml`) runs `check`, `typecheck`, `test`, and a docs build on every pull request.

## Architecture

Blume ships as a single published package, `packages/blume`, with internal modules under `src/`:

| Module | Responsibility |
| --- | --- |
| `cli` | `blume` command entrypoint and subcommands |
| `core` | Config, content discovery, graph, navigation, content sources, i18n, diagnostics |
| `astro` | Generated runtime, templates, integration, page discovery |
| `components` | Default Astro/React components, islands, layout |
| `markdown` | remark/rehype plugins — Shiki, math, Mermaid, directives |
| `theme` | CSS tokens, fonts, icon set, palette |
| `search` | Search index build and provider adapters (Orama by default) |
| `og` | Open Graph images rendered at build with Takumi |
| `seo` | JSON-LD structured data |
| `deploy` | Adapter output, sitemap, `robots.txt`, RSS, redirects |
| `openapi` | OpenAPI/AsyncAPI parsing and reference rendering |
| `ai` | `llms.txt` generation, Ask AI, MCP server |
| `registry` | `blume add` registry and `blume eject` |
| `runtime` | Public runtime helpers for custom pages and islands |

Agent skills live in `skills/` at the repo root and are bundled into the published package.

### Runtime model

The CLI loads config, scans content into a graph, and writes a hidden Astro project to `.blume/`. Generated files are owned by Blume and recreated on each run; only changed files are rewritten so Vite HMR stays fast. `.blume/` is safe to delete.

The generated catch-all page imports shipped components from `blume/...`, the generated data module, and user overrides. `blume eject` regenerates the same files with project-relative paths into your project and removes `.blume/`.

## Conventions

- Components are styled with Tailwind v4 utilities (via `@tailwindcss/vite` in the generated runtime) — no hand-written CSS files. Design tokens live as `--blume-*` variables mapped into Tailwind's theme; the typography plugin styles MDX content (`prose`). Users never configure Tailwind themselves.
- Code style is enforced by [Ultracite](https://github.com/haydenbleasel/ultracite) (oxlint + oxfmt). Use arrow function expressions, sorted object keys, and `u`-flag regular expressions with named groups.
- `.astro` files are not linted by oxlint (it misparses single-file `.astro` syntax), and nothing type-checks the package's components yet: `tsgo` never sees `.astro`, and the docs app's `blume check` only covers its own files. Review `<script>` blocks by hand — a bare identifier there ships as a runtime `ReferenceError`. Astro components use PascalCase.
- Tests run on Bun's `bun:test` runner, so the Vitest lint preset is intentionally not extended.
- Generated runtime files (`.blume/`) are excluded from linting and formatting.

## Releases

Releases use [Changesets](https://github.com/changesets/changesets):

```bash
bunx changeset          # describe your change
```

Merging a changeset to `main` opens a release PR; merging that publishes.
