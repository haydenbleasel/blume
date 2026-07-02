# Blume — TODO

Outstanding work. Add items with enough context (what, where, why) to act on later.

## Mintlify migrator — gaps found migrating a Mintlify site

Source: analysis of a large Mintlify site (two sub-sites — a product/API docs site and an internal/architecture site), run through `blume migrate mintlify`. Ordered by impact.

### High impact

- [ ] **Map the Mintlify `openapi` block → Blume `openapi.sources`.** The site's entire REST API reference is a remote spec declared in nav (`"openapi": { "source": "https://…" }`). `loadMintlifyConfig` (`src/migrate/mintlify/config.ts`) never reads a top-level or per-group `openapi` key, and `navItemPath` skips `GET /path` endpoint refs — so the API reference is dropped **silently** (no `openapi:` in the output config, no warning). Blume renders remote specs natively now (`openapi.sources[].spec` accepts `http(s)` URLs → one real page per operation), so this is pure wiring. At minimum emit a warning when a Mintlify `openapi` source is found and skipped.

- [ ] **`<ParamField>` / `<ResponseField>` / `<RequestField>` have no Blume equivalent.** ~488 uses across ~64 files (CLI flags, SDK method signatures, hand-written endpoint fields, often nested in `<Expandable>`). Migrator flags them (`UNSUPPORTED_COMPONENTS` in `src/migrate/mintlify/content.ts`) but leaves them verbatim → they fail to compile as undefined MDX components. Options: ship compat components, or auto-convert to `TypeTable`/`AutoTypeTable` + `Expandable` (the native OpenAPI renderer now shares schema/parameter rendering in `src/components/openapi/` — a `<ParamField>` compat could reuse it). Also fix the migrator's misleading "use the OpenAPI reference instead" hint — most of these document CLI/SDK surfaces an OpenAPI spec doesn't cover.

- [ ] **Expand FontAwesome icon coverage.** The site is `icons.library: fontawesome`; 90 distinct icon names on 275 `<Card>`s, 118 `<Step>`s, `<Icon>` tags, and sidebar groups. Blume ships a curated ~71-icon Lucide set + a 15-entry alias map (`src/theme/icons.ts`); **75/90 names don't resolve** (`gauge-high`, `arrows-rotate`, `shield-halved`, `layer-group`, `node-js`, `wand-magic-sparkles`, `bread-slice`, `user-shield`, …) and render as nothing. Grow the icon set and/or the FA→Lucide alias map so common FontAwesome names resolve.

### Medium impact

- [ ] **Migrate site chrome that's currently dropped** (`src/migrate/mintlify/config.ts`): `navbar.links` + `navbar.primary`, `footer.socials`, and `fonts.family` (Blume ships a `geist` slug, so map it). `contextual.options` and `metadata.timestamp` are ~covered by Blume defaults (PageActions, git-derived last-updated) — verify, then either map or document as no-ops.

- [x] **Translate wildcard redirects to Astro syntax.** `mintlifyRedirects` copies `from`/`to` verbatim, so a `/old/:slug*` → `/new/:slug*` redirect reaches Astro's `redirects` unchanged and never matches (Astro uses `[...slug]`, not `:slug*`). Convert `:param*` / `:param` path-to-regexp segments to Astro dynamic segments.

- [ ] **Preserve `authors` frontmatter.** Blume's `pageMetaBaseSchema` (`src/core/schema.ts`) keeps `date` but not `authors`; the migrator drops it (seen on ~17 changelog/blog files). Add `authors` to the schema or fold it into an existing field.

### Low / quality

- [ ] **Consider deriving `sidebarVariants` at build time instead of inlining them.** Migrating a large site's docs produced a **4.9 MB / 126k-line `blume.config.ts`** — 99% of it is 265 pre-computed sidebar variants (`mintlifySidebarVariants`). Valid and functional, but effectively un-hand-editable and noisy in git. Evaluate whether Blume can compute variants from the nav tree at build time so the migrator emits a small, readable config.
