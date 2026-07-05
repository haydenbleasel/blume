# Fumadocs → Blume

Fumadocs is code-first on Next.js: navigation comes from the folder tree + per-folder `meta.json`. This maps cleanly to Blume — most content passes through, and `meta.json` becomes `meta.ts`.

## Detect

- Content under **`content/docs/`** (the Fumadocs convention).
- Per-folder **`meta.json`** files.
- `fumadocs-ui` / `fumadocs-core` / `fumadocs-mdx` deps and a `source.config.ts`.
- A `loader({ baseUrl: "/docs" })` call in `lib/source.ts` (or `app/source.ts`, `src/lib/source.ts`, `source.ts`).

## Config

Fumadocs declares almost nothing Blume needs — only two things map:

- **Title** — read `package.json` `name`, prettified (drop scope, split on `-_`, Title-Case). For a generic monorepo name (`web`, `app`, `docs`…), use the repo-root directory name instead.
- **Route prefix** — the `baseUrl` in the source loader (default `"docs"`). If non-empty, set `content.sources: [{ type: "filesystem", root: "docs", prefix: "<baseUrl>" }]` so docs serve under `/<prefix>`. If `baseUrl` is `"/"`, serve from the site root (no `sources`).

Everything else is `defineConfig({ title })`.

## Navigation: `meta.json` → `meta.ts`

**Every `meta.json` becomes a `meta.ts` — this is the primary navigation carry-over for Fumadocs, always required, never optional.** `meta.json` is Fumadocs' canonical nav source; no filesystem-only shortcut reproduces its ordering, icons, and collapse state, so don't skip it in favor of filename inference. Move content from `content/docs/` to your chosen `content.root` (e.g. `docs/`), then convert each `meta.json` to a `meta.ts` (`defineMeta`):

| Fumadocs `meta.json` | Blume `meta.ts`                                  |
| -------------------- | ------------------------------------------------ |
| `title`              | `title`                                          |
| `icon`               | `icon` (already a Lucide name — pass through)    |
| `defaultOpen: true`  | `display: "group"`, `collapsed: false`           |
| `defaultOpen: false` | `display: "group"`, `collapsed: true` (inverted) |
| `root: true`         | `display: "page"` (drill-in sub-panel)           |
| `pages: [...]` slugs | `pages: [...]` (ordering)                        |
| `description`        | **drop** (folders have no description)           |

Handle the `pages` array items:

- **`"..."`** (rest marker) / `""` → drop; Blume appends unlisted pages automatically.
- **`"---Section---"`** (separator) → Blume has no flat separator. Turn each section into a **`(Section)/` group folder** (route-transparent — the `(…)` segment is stripped from URLs), and move the section's pages into it. If a section wraps a single existing folder, leave it in place and set that folder's `meta.ts` `title` instead.
- **`"...folder"`** (extract) → Blume can't flatten a folder inline; keep it as a normal group at that ordering position and report it.
- **`"[Text](url)"`** (link) → drop and report (no folder-meta home for external links).

## Frontmatter

Fumadocs' core frontmatter (`title`, `description`, `icon`) already matches Blume — pass through. The only notable drop is **`full`** (Fumadocs' full-width/no-TOC layout) — no equivalent; report it. Any other non-schema key is a build error, so drop and report.

## Components

- **Callouts:** `<Callout type="x">` → `:::` directive. `warn`→warning, `error`→danger, `info`/`note`/`tip`/`success`/`warning` pass through, bare `<Callout>`→`:::note`. `title` → `:::type[Title]`; drop `icon`.
- **Container/item renames** (note the Accordion inversion):
  - `<Cards>` → `<CardGroup>`; `<Card>` stays.
  - `<Accordions>` → `<Accordion>` (container); `<Accordion>` → `<AccordionItem>` (item).
  - `<Files>` → `<FileTree>`; `<Folder>` → `<Tree.Folder>`; `<File>` → `<Tree.File>` (or convert the whole block to a list-driven `<FileTree>`).
- **Tabs:** Fumadocs declares labels on the parent (`<Tabs items={['npm','pnpm']}>`) and selects with `<Tab value="npm">`. Blume's `<Tab>` carries its own `title`. Strip `items={[…]}` from `<Tabs>` and give each child `<Tab>` a `title` (from its `value`, or the positional `items` entry).
- **`<Steps>`/`<Step>`** — Blume ships these; pass through.
- **`<include>./partial.mdx</include>`** — Blume has no runtime include. **Inline** the partial's body (strip its frontmatter) at migration time; resolve nested includes recursively.
- **No equivalent — report:** `<Banner>`, `<DynamicCodeBlock>`, `<ImageZoom>` (Blume zooms content images by default), `<InlineTOC>`.
- Strip `import … from "fumadocs-ui|core|mdx"` lines — Blume injects components globally.

## Icons

Fumadocs uses Lucide names already — **pass through** unchanged (frontmatter `icon`, `meta.json` `icon`).

## Package.json & teardown

Repoint scripts (`dev`→`blume dev`, `build`→`blume build`, `start`→`blume preview`), remove `next`/`fumadocs-*` deps, add `blume`. Safe to delete after verifying: `next.config.*`, `source.config.*`, `mdx-components.tsx`, `next-env.d.ts`, the `app/` route dir, and the `next` plugin from `tsconfig.json`.

## Dropped — report these

Folder `description`; sidebar links & separators (recreate via group folders / config); the extract (`...folder`) flatten semantics; frontmatter `full`; unsupported components above.
