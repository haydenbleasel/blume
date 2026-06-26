# Blume — agent notes

Blume is an open-source, markdown-first docs framework on Astro/Vite, shipped as
a single package (`packages/blume`). The plan/spec lives in `plan/` (do not
reformat it).

## Commands

- `bun run check` / `bun run fix` — Ultracite lint + format (oxlint + oxfmt)
- `bun run typecheck` — tsc across packages
- `bun run test` — Vitest (`packages/blume/test`)
- Run the CLI locally: `cd docs && bun ../packages/blume/bin/blume.mjs <cmd>`

## How it works

The CLI (`src/cli`) loads `blume.config.ts`, scans content into a graph
(`src/core`), and generates a hidden Astro project under `.blume/`
(`src/astro/generate.ts` + `templates.ts`). Astro renders via a catch-all page
that imports shipped components from `blume/...`, the generated data module, and
user overrides. `.blume/` is regenerated each run; only changed files are
written (HMR-friendly).

## Module map (packages/blume/src)

`cli` commands · `core` config/content/graph/navigation/manifest/diagnostics ·
`astro` runtime generation + integration · `components` Astro/React UI ·
`theme` Tailwind v4 entry/tokens/icons/palette · `search` Orama (default, dev + build) + Pagefind opt-in · `registry` add + eject ·
`migrate` migrators · `openapi` import · `ai` llms.txt + Ask AI endpoint ·
`og` Takumi-rendered Open Graph images · `markdown` Satteri processors
(`blumeMarkdownProcessor` for `.md`, `blumeMdxProcessor` for `.mdx`): curated
feature set (GFM/frontmatter/smart punctuation/super+subscript) and MDX-only
MDAST plugins — `package-install` → package-manager tabs, `:::note` directives →
`<Callout>`, opt-in KaTeX math (`markdown.math`) → `<Math>`, and ` ```mermaid `
→ a client-rendered `<blume-mermaid>` element (lazy-loads Mermaid).

## Conventions

- Components are styled with Tailwind v4 utility classes (no CSS files). The
  generated runtime imports a single Tailwind entry (`blume:theme` alias →
  `.blume/src/generated/app.css`) that `@source`s the package, maps Tailwind
  tokens to `--blume-*` vars, and appends config + user `theme.css` overrides.
- Arrow function expressions, sorted object keys, `u`-flag regex with named
  groups (Ultracite rules). `.ts` import extensions are used everywhere.
- `.astro` files use PascalCase and are excluded from oxlint; the core theme is
  React-free (vanilla custom elements). React auto-enables only when the project
  has `.tsx`/`.jsx` or Ask AI is on.
- Generated `.blume/` and `plan/` are excluded from lint/format.
- Commit per milestone; keep the docs (`docs/`) building.
