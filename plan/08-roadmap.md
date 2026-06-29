# Roadmap

## M0: Astro/Vite prototype

Goal: prove the hidden runtime model.

Deliverables:

- `blume dev`
- generated `.blume/astro.config.mjs`
- one catch-all Astro page
- render Markdown/MDX from `docs/`
- generated route manifest
- basic layout
- Vite HMR for content edits

Exit criteria:

- a docs folder renders without an Astro app
- deleting `.blume/` and rerunning works
- dev startup feels Vite-native

## M1: Content graph

Deliverables:

- config loader
- frontmatter schema
- route normalization
- heading extraction
- link extraction
- nav graph
- duplicate route diagnostics
- strict build mode

Exit criteria:

- errors are file-specific and actionable
- generated nav works without manual config

## M2: Default theme

Deliverables:

- Astro-first layout components
- sidebar
- mobile nav
- TOC
- breadcrumbs
- pagination
- code blocks
- callouts/cards/steps/tabs
- CSS variables
- light/dark mode

Exit criteria:

- default site is polished enough for a public project
- no user Tailwind setup required

## M3: Search

Deliverables:

- Pagefind integration
- search modal island
- keyboard shortcut
- indexing config
- search exclusion metadata

Exit criteria:

- local search works in static output
- search does not require hosted infrastructure

## M4: Customization

Deliverables:

- `components.ts` with `defineComponents`
- `.astro` component overrides
- React island overrides with hydration metadata
- `theme.css`
- `pages/**/*.astro`
- registry proof of concept

Exit criteria:

- user can replace a built-in component
- user can add an interactive React widget
- user can add a custom Astro page

## M5: API/reference content

Deliverables:

- OpenAPI import
- endpoint pages
- schema tables
- request/response examples
- code sample blocks
- API nav grouping

Exit criteria:

- Blume can host real SDK/API docs without bespoke pages

## M6: AI features

Deliverables:

- `llms.txt`
- `llms-full.txt`
- optional Ask AI React island
- Astro endpoint for Ask AI
- AI SDK through Vercel AI Gateway model strings
- static embeddings/indexing exploration

Exit criteria:

- AI is useful but optional
- static docs remain static when AI is disabled

## M7: Deployment

Deliverables:

- static `dist/` output
- Vercel adapter path
- Node adapter path
- sitemap
- redirects
- dynamic OG endpoint in server mode
- deploy diagnostics

Exit criteria:

- static deploy is one command
- server deploy is documented and predictable

## M8: Migration and eject

Deliverables:

- `blume migrate mintlify`
- `blume migrate starlight`
- `blume migrate fumadocs`
- `blume eject`
- generated diff preview

Exit criteria:

- migration preserves content
- eject produces a normal Astro project

## M9: Public beta

Deliverables:

- docs site
- examples
- component registry
- contributor guide
- release workflow
- compatibility matrix

Exit criteria:

- real users can adopt without hand-holding
- project direction is legible to contributors
