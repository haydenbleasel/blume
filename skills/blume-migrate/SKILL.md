---
name: blume-migrate
description: Migrate an existing documentation site (Mintlify, Docusaurus, Fumadocs, Nextra, Starlight, or any docs framework) to Blume, the markdown-first docs framework on Astro. Translate the source config to blume.config.ts, restructure content into Blume's filesystem-derived navigation, rewrite JSX callouts to directives, convert icons to Lucide, and inline snippets. Use when the user asks to migrate/convert/port a docs repo to Blume, or when the repo has a docs.json/mint.json, docusaurus.config.*, meta.json with fumadocs, _meta.* with nextra, or an astro.config.* with starlight().
---

# Migrate to Blume

Blume is a **markdown-first** documentation framework on Astro/Vite. You drop Markdown/MDX into a folder and get navigation, search, theming, Open Graph images, and a component library with no app boilerplate — **the framework is the template**. There is no starter to clone; the only thing a project owns is its content and a `blume.config.ts`.

Your job is to convert a source docs repo into an **idiomatic** Blume project — not a 1:1 transliteration. Read this file, detect the source framework, open the matching `references/<framework>.md` for the exact mappings, and work the loop below. Report everything you drop or approximate.

## Migration philosophy

- **Target idiomatic Blume, not a mechanical port.** Prefer filesystem-derived navigation over an exhaustive explicit `navigation.sidebar`. Prefer `:::` directives over JSX callouts. Prefer Blume defaults over restating them in config.
- **Every field has a default; `{}` is a valid config.** Map only what the source _declares_. If the source uses a framework default, don't write it.
- **Drop chrome that has no Blume equivalent — and say so.** Navbar CTAs, footer columns, custom theming, dynamic redirects, and unmappable icons get reported to the user, not silently discarded or faked.
- **Convert, don't preserve.** Blume's page frontmatter schema is **strict** — unknown keys are build errors. A source-only frontmatter key must be mapped to a Blume key or removed (and reported), never left to "maybe validate."

## Migration workflow

1. **Detect the source framework** and read its reference file:
   - `docs.json` / `mint.json` → **Mintlify** (`references/mintlify.md`) — the deepest, config-declared nav.
   - `docusaurus.config.*` → **Docusaurus** (`references/docusaurus.md`).
   - `meta.json` + `fumadocs-*` deps (content under `content/docs/`) → **Fumadocs** (`references/fumadocs.md`).
   - `_meta.{js,ts,json}` + `nextra` deps → **Nextra** (`references/nextra.md`).
   - `astro.config.*` calling `starlight({…})` → **Starlight** (`references/starlight.md`).
   - Anything else → apply this file's mental model directly; there's no framework-specific reference, so inventory by hand.
   - **Also note the host repo, independent of source framework:** a pnpm/Turbo workspace, a non-`docs/` content layout, or a Vercel deploy each need integration steps (`content.root` scoping, `minimumReleaseAge`, lockfile, `vercel.json`, an Astro/Vite patch) — all in `references/monorepo.md`. Read it whenever the target isn't a bare single-package docs folder.
2. **Inventory the repo** before changing anything: the config file(s), the content tree, the nav definition, snippets/partials/includes, static assets, OpenAPI/AsyncAPI specs, redirects, i18n locales, custom components, and icon usage. Note what's declared vs. defaulted.
3. **Write `blume.config.ts`** with `defineConfig` from `blume`. Map only declared fields (see the reference's mapping table); rely on defaults everywhere else. A minimal result is `defineConfig({ title: "…" })`.
4. **Restructure content.** Choose `content.root` (default `docs`) — **detect where `.md`/`.mdx` actually live, don't assume a `docs/` folder.** Many repos keep content directly under an app dir (`apps/docs/api/`, `.../getting-started/`) with no `docs/` subfolder; when so, set `content.root` to that dir and scope `content.include` to the real content folders rather than leaving a bare `content.root: "."` that scans everything (see `references/monorepo.md` §1). Order with numeric prefixes (`01-intro.mdx`), group without a URL segment via `(group)/` folders, and add a `meta.ts` (`defineMeta`) only where filesystem order isn't enough. Reach for an explicit `navigation.sidebar` only when the source nav genuinely can't be expressed by files. **Reshaping into folder-per-tab moves URLs** — track every old→new path as you go; you'll turn them into `redirects` in step 5.
5. **Rewrite pages.** Map frontmatter to Blume's strict schema; convert callout JSX to `:::` directives; rename components; inline snippets/partials (Blume has no import-based includes); fix asset paths; **rewrite internal links** to their new routes (including OpenAPI operation links — see the OpenAPI section, their slugs differ from most sources); **add a `redirects` entry for every route you moved** in step 4; **convert every icon name to Lucide** (Blume is Lucide-only — no FontAwesome/Tabler). Remove any duplicated H1 in the body (`title` renders the H1; bodies start at `##`). For **Mintlify**, run the bundled codemod first — `node <skill>/scripts/mintlify-codemod.mjs --write <content-dir>` deterministically remaps icons and drops/renames unsupported frontmatter keys, and reports the rest (unknown icons, OpenAPI-stub flags) for you to finish by hand (see `references/mintlify.md`).
6. **Adopt `package.json`.** Repoint `dev`/`build`/`start` → `blume dev`/`blume build`/`blume preview`, remove the old framework's deps, add `blume`. A config-only source (e.g. a bare Mintlify `docs.json`) has no manifest — scaffold one. **In a pnpm workspace:** if `pnpm-workspace.yaml`/`.npmrc` sets `minimumReleaseAge`, add **only** `blume` to `minimumReleaseAgeExclude` (don't disable the guard) so the just-published version installs. **Always regenerate the lockfile in the same change:** after editing deps run a plain `pnpm install` (from the workspace root) and commit `pnpm-lock.yaml` alongside `package.json` — CI/Vercel use `--frozen-lockfile`, so a stale lockfile fails the build before it starts. See `references/monorepo.md` §2–3.
7. **Wire up the host repo & deploy (non-trivial repos).** For a monorepo on Vercel, emit the root-aware install/build recipe and `apps/docs/vercel.json`, and tell the user the two settings you can't commit (Vercel Root Directory, Node 22). If the workspace pins Vite and `blume build` crashes inside Astro/Vite, apply the pnpm-patch workaround. All copy-pasteable in `references/monorepo.md` §4–5.
8. **Verify.** Run `blume build` (it validates links, anchors, frontmatter schema, and duplicate routes), fix diagnostics, then `blume dev` for a visual pass. End with a written summary of what was migrated, dropped, and approximated — **and every repo-specific edit you made** (pnpm-workspace, vercel.json, config globs) with the reason, plus any manual step left to the user (the Astro patch, Vercel dashboard settings).

## The Blume mental model

The single biggest shift for most sources — especially Mintlify — is that **navigation is derived from the filesystem**, not declared in config.

### Navigation is the file tree

- **Folders become groups, files become pages.** A page's sidebar label is its frontmatter `title`; a group's label is the humanized folder name.
- **Ordering resolves highest-priority-first:** an explicit `navigation.sidebar` (replaces the whole tree) → a folder's `meta.ts` `pages` array → a page's frontmatter `sidebar.order` → the filesystem (`index` first, then numeric filename prefix like `01-`, then alphabetical).
- **`meta.ts` refines one folder** (`defineMeta({ title, icon, order, display, collapsed, pages })`). `display` is `"flat"` (default), `"group"` (collapsible), or `"page"` (drill-in sub-panel). The `pages` array lists children by slug (numeric prefix and parentheses stripped); **children you omit sort _after_ the listed ones** — so list `"index"` first when you set `pages`, or the folder's landing page (the tab's target) sinks to the bottom.
- **An explicit `navigation.sidebar` replaces filesystem generation entirely.** Use it only for a nav shape files can't express. Its items are a page route string, a group (`{ label, items }`), or a link (`{ label, href }`).
- **Config-declared nesting has no on-disk counterpart — materialize it or it flattens silently.** When a source (Mintlify `groups`, Nextra `_meta`, a Docusaurus sidebar…) declares a nested group, its pages usually sit **flat in one folder** and the grouping lives only in config. Filesystem-derived nav sees the flat folder and drops the inner group. To keep the nesting you must **either** move those pages into a real subfolder (`meta.ts` for label/`collapsed`) — which changes their URLs, so add `redirects` — **or** declare the group in an explicit `navigation.sidebar`, which nests the existing routes without moving a file. Walk config `pages`/nav arrays **recursively** during inventory and record where config nesting depth exceeds on-disk depth; that gap is exactly what gets lost.

### Tabs and selectors

- **`navigation.tabs`** (`{ label, path, icon? }`) render top-of-header sections and **scope the sidebar**: under a tab's `path`, the sidebar shows only that folder. Structure content as **one folder per tab**.
- **`navigation.selectors`** (`{ kind, label, items: [{ label, path, icon?, description?, tag? }] }`, `kind` = `dropdown`/`product`/`version`/`language`) partition a whole site (products, versions) via a header dropdown keyed on the current route.

### Routes and pathing

- A route is the content path relative to `content.root`, with **numeric prefixes stripped** (`01-intro.mdx` → `/intro`) and **`(group)/` folders adding no segment**. An `index` file maps to its folder's route. Frontmatter `slug` overrides the generated route.

### `blume.config.ts` shape

`defineConfig({...})` — every field optional, all with defaults:

- **Site:** `title`, `description`, `logo` (string SVG, or `{ image: string | { light, dark, alt }, text, href }`), `banner` (`{ content, link, dismissible, id }` — no color/type). A logo renders beside `title` in the header, so a **wordmark logo doubles the brand** ("Acme Acme") — set `text: ""` to render the mark alone.
- **`theme`:** `accent`/`accentDark`/`action` (colors), `mode` (`light`/`dark`/`system`), `strict`, `radius`, `fonts` (`{ body, display }` — curated Google-font slugs), `background`/`backgroundDark`/`backgroundImage`/`backgroundImageDark`, `css`.
- **`content`:** `root` (default `"docs"`, relative to the project dir where `blume` runs), `include`/`exclude` (arrays of globs **relative to `content.root`**; defaults `["**/*.{md,mdx}"]` / `["**/_*", "**/.*"]`), `sources` (staged sources: openapi, github-releases, notion, sanity, mdx-remote…), `pages` (custom `.astro` dir), `defaultType`. When docs sit directly under the project dir (no `docs/` subfolder), set `root` there and **scope `include` to the real content folders** instead of scanning everything — `references/monorepo.md` §1.
- **`navigation`:** `tabs`, `selectors`, `sidebar`, `repo`.
- **`search`** (Orama default, Pagefind opt-in), **`ai`** (llms.txt, Ask AI), **`mcp`**, **`openapi`**, **`redirects`**, **`seo`**, **`markdown`**, **`analytics`**, **`deployment`**, **`i18n`**, **`toc`**, **`lastModified`**, **`github`**.
- **Favicon is a filename convention, not config.** Drop `icon`/`favicon.{svg,png,ico}` (and `apple-icon.png`) in the project root or `public/` — Blume auto-detects it. There is **no** `favicon` config field. A source favicon given as `{ light, dark }` **collapses to one** — pick a single file and report the loss.

The schema is exported from `blume/schema`; the full field reference is in `node_modules/blume/docs/configuration/`.

### Icons are Lucide, period

Blume resolves **bare [Lucide](https://lucide.dev) names** everywhere an icon is accepted — frontmatter `icon`, `sidebar.icon`, `meta.ts` `icon`, `navigation.tabs`/`selectors` icons, and `Card`/`Step`/`Icon`/etc. props. There is **no** FontAwesome or Tabler support and **no** `iconType` prop or `library:` prefix. When migrating a source that uses another icon set (Mintlify defaults to FontAwesome), **map each name to its closest Lucide equivalent**; where none exists, drop the icon and report it. Verify a name exists at [lucide.dev/icons](https://lucide.dev/icons) before writing it.

### Page frontmatter (strict — unknown keys are build errors)

```yaml
---
title: Install # renders as the page H1 — remove any duplicate H1 in the body
description: Install Blume and scaffold your first project.
type: doc # doc (default) | blog | changelog | api
icon: download # a Lucide name
sidebar:
  label: Install # overrides title in the sidebar
  order: 2
  icon: download
  badge: New
  hidden: false
seo:
  title: …
  description: …
  image: /og/install.png
  canonical: https://…
  noindex: false
search:
  exclude: false
  tags: [api]
slug: install # override the generated route
draft: false
lastModified: 2026-06-20 # pin the "last updated" date
---
```

Also valid: `date`/`authors` (blog/changelog feeds), `changelog` (changelog metadata), `deprecated`, `hidden`, `noindex`.

### Authoring features (no imports needed in `.md`/`.mdx`)

- **Callouts as directives:** `:::note`, `:::tip`, `:::warning`, `:::danger`, `:::info`, `:::success`, with an optional title in brackets: `:::warning[Heads up]`. Aliases `caution`→warning, `error`→danger, `important`→note, `warn`→warning. These work in **both** `.md` and `.mdx`.
- **No-import MDX components:** `Card`/`CardGroup`, `Columns`/`Column`, `Steps`/`Step`, `Tabs`/`Tab`, `Accordion`/`AccordionItem`, `Expandable`, `FileTree`, `Tree`/`Tree.Folder`/`Tree.File`, `CodeGroup`, `Frame`, `Panel`, `Tooltip`, `Tile`, `Badge`, `Icon`, `TypeTable`/`AutoTypeTable`, `Color`, `YouTube`, `Visibility`, `GithubInfo`, `Component`, `CodeBlock`, `Diff`, `Prompt`, `Math`. (**Not** shipped — convert away: `<Warning>` → the `:::warning` directive, and the `ParamField`/`ResponseField`/`RequestField` field family → `TypeTable` rows or the OpenAPI reference. See the reference files for targets.)
- **Fenced-code superpowers:** ` ```package-install ` → package-manager tabs; ` ```mermaid ` → a rendered diagram; code-block titles (` ```ts server.ts `), line numbers (`lineNumbers`), and highlighting (`{1,4-5}`, `// [!code ++]`).
- **Math** (`$…$`, `$$…$$`) is opt-in via `markdown: { math: true }`.

### OpenAPI

`openapi: { enabled: true, sources: [{ spec, label?, route? }] }` generates **one real page per operation** — with routing, sidebar, search, and OG images for free, plus a header tab for the source. **Never hand-migrate generated API-reference pages** (per-endpoint stub pages in the source): delete them and point `openapi.sources` at the spec. (`renderer: "scalar"` keeps the Scalar embed instead; AsyncAPI uses the same embed.)

- **Vendor the spec by default.** A remote `spec:` URL makes every build depend on fetching it at build time — a single point of failure in CI, offline, or behind a proxy, and a failed fetch skips the whole reference. Prefer committing the spec into the repo (`openapi/<name>.json`) and pointing `spec` at the local path; if you keep the URL, say so and consider a `prebuild` step that refreshes the local copy with a fallback.
- **Operation routes have their own slug scheme** — `<route>/<slugified-tag>/<slugified-operationId>` (e.g. tag `Models`, id `listModels` → `/api-reference/models/listmodels`). This rarely matches the source's endpoint links (Mintlify/others kebab-case differently), so **rewrite every inbound link to an operation** and verify it against the built routes — `blume build`'s link check does **not** catch dead links to OpenAPI-generated pages.
- **Keep hand-written conceptual pages.** Sources often pair a written "Introduction/Authentication" page with the endpoint group in the same tab. A normal content page placed under the openapi `route` merges into the reference tab's sidebar — so keep those (auth, errors, rate limits) and delete only the per-endpoint stubs.

### Redirects are static

A `redirects: [{ from, to, status? }]` array **in `blume.config.ts`** maps old URLs when you restructure routes — Blume serves these itself, so any reorganization that moves a page (folder-per-tab, materialized nested groups, renamed slugs, index promotion) is fixed by adding an entry there; no host config needed. **Restructuring is the main source of these:** every page you moved in step 4 (folder-per-tab, renamed slugs, index promotion) needs an entry, or old URLs 404. `status` defaults to **301 (permanent — browsers cache it indefinitely)**; that's correct for genuine moves, but never use 301/308 for redirects you might reverse. Dynamic/wildcard patterns (`:slug*`) can't be modeled as static path-to-path; move those to host-level config (`_redirects`, `vercel.json`) and report them.

## Verification & reporting

1. Run `blume build`. It validates internal links, heading anchors, the frontmatter schema, and duplicate routes. Iterate until clean. **Caveat:** the link check doesn't resolve OpenAPI-generated routes, so a dead link to an operation page builds clean — verify those by hand against the built routes (or in `blume dev`).
2. Run `blume dev` and review the site visually — nav structure, tabs, theme, rendered components.
3. **Write a migration summary** covering: what was migrated (config, N pages, nav, OpenAPI), what was **dropped** (navbar CTAs, footers, custom theming, dynamic redirects, unmappable icons, unsupported components), and suggested follow-ups (`blume eject` for full control, `blume add` to vendor a component for customization).

## Full documentation

The mapping details live in `references/`: one file per source framework (`mintlify.md`, `docusaurus.md`, `fumadocs.md`, `nextra.md`, `starlight.md`), plus **`monorepo.md`** for host-repo integration (content-layout detection, pnpm `minimumReleaseAge`, frozen-lockfile regeneration, the Vercel monorepo recipe, and the Astro/Vite patch). The Mintlify icon + frontmatter pass is automated by **`scripts/mintlify-codemod.mjs`** (zero-dependency, deterministic, idempotent; `--write` to apply). The authoritative Blume docs are bundled in the installed package at **`node_modules/blume/docs`** (or `apps/docs/content/docs` in a repo checkout). The most relevant pages:

- `configuration/index.mdx` — every `blume.config.ts` field.
- `content/navigation.mdx` — the sidebar/tabs/selectors model.
- `content/meta.mdx` — `meta.ts` and display modes.
- `content/syntax.mdx` — directives, code features, math.
- `content/components.mdx` — the component library and APIs.
- `reference/frontmatter.mdx` — the strict page schema.
