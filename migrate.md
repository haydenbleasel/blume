# Replace `blume migrate` + bridge mode with a `/blume-migrate` agent skill

## Context

The programmatic migrators (`blume migrate <tool>`) and the automatic Mintlify bridge mode have both been tested on real repos and produce headaches — docs repos differ too much structurally for a codemod to be reliable. The plan: delete both, and replace them with a comprehensive agent skill (`skills/blume-migrate/`) that teaches Claude Code / Codex everything needed to migrate a repo to Blume idiomatically. An LLM can handle the per-repo variance a codemod can't.

Decisions confirmed with the user:

- **Bridge is removed entirely** (it's not a command — it's the automatic `docs.json` runtime mode wired through `core/config.ts`, `core/bridge.ts`, `core/sources/mintlify.ts`, and the schema). This unblocks deleting `src/migrate/` wholesale, since bridge reuses the Mintlify transform code.
- **Mintlify-compat config surface is pruned.** The fields that exist only to accept Mintlify config — `banner.color`, `banner.type`, top-level `favicon`, `navigation.chromeVariants`, and the `icons` config — validate but are never rendered. All go. (`navbar`/`footer`/`contextual`/`styling` were already pruned; `test/schema-coverage.test.ts` asserts they're rejected.)
- **The icon system becomes Lucide-only.** The fontawesome/tabler iconify support (added purely for Mintlify icon names) is scrapped — `icons.library` config, `iconType` frontmatter/props, `fa6-*`/`tabler` prefixes, and the four `@iconify-json/fa6-*`/`@iconify-json/tabler` deps. The skill converts source icons to their Lucide counterparts during migration.
- **Skill covers all frameworks** — shared Blume-concepts core + per-framework reference files; Mintlify deepest; Docusaurus gains coverage the codemod never had.
- **`advanced/migrate.mdx` is rewritten** for the skill flow; `advanced/bridge.mdx` deleted; homepage Migrate section kept but repointed. Install command: `npx skills use haydenbleasel/blume@blume-migrate` (folder name and `@suffix` must match — using `blume-migrate` per the original naming; flag if `migrate-blume` was intended).
- **`skills/` ships in the npm package** so installed users also get it at `node_modules/blume/skills` (the `npx skills` GitHub path is the primary install).

## Implementation order

Write the skill **first** (while `src/migrate/` still exists as the authoritative mapping reference), then delete migrate + bridge, then prune the compat surface, then docs/homepage/packaging. Commit per milestone, keeping `apps/docs` building.

---

## Part A — Write the skill: `skills/blume-migrate/`

Match the conventions of `skills/blume/SKILL.md`: two-key YAML frontmatter (`name`, plus a long single-sentence `description` ending in a "Use when …" trigger clause), H1 + `##` sections, bold-lead bullets, code-example-driven, defers exhaustive detail to `node_modules/blume/docs`.

```
skills/blume-migrate/
  SKILL.md                 # workflow + Blume mental model (keep < ~500 lines)
  references/
    mintlify.md            # deepest: docs.json → blume.config.ts + content transforms
    docusaurus.md          # new coverage (no codemod ever existed)
    fumadocs.md
    nextra.md
    starlight.md
```

### SKILL.md content

**Frontmatter** — `name: blume-migrate`; description like: "Migrate an existing documentation site (Mintlify, Docusaurus, Fumadocs, Nextra, Starlight, or any docs framework) to Blume… Use when the user asks to migrate/convert/port a docs repo to Blume, mentions docs.json/mint.json, docusaurus.config, meta.json, \_meta files, or astro.config with Starlight…"

**Sections:**

1. **What Blume is + migration philosophy** — target the _idiomatic_ Blume outcome, not a 1:1 transliteration. Prefer filesystem-derived navigation over exhaustive explicit config; prefer directives over JSX callouts; drop chrome that has no equivalent and tell the user what was dropped.
2. **Migration workflow** (the core loop):
   1. Detect the source framework (`docs.json`/`mint.json` → Mintlify; `docusaurus.config.*` → Docusaurus; `meta.json` + fumadocs deps → Fumadocs; `_meta.*` + nextra → Nextra; `astro.config.*` with `starlight()` → Starlight) and read the matching `references/<framework>.md`.
   2. Inventory the repo: config, content tree, nav definition, snippets/partials, assets, OpenAPI specs, redirects, i18n, custom components, icon usage.
   3. Write `blume.config.ts` (`defineConfig` from `blume`) — map only what the source declares; rely on Blume defaults everywhere else.
   4. Restructure content: choose `content.root`, use numeric prefixes (`01-`) for ordering, `(label)/` group folders, `meta.ts` (`defineMeta`) only where filesystem order isn't enough.
   5. Rewrite pages: frontmatter → Blume's strict page schema; callout JSX → `:::` directives; component renames; inline snippets/partials; fix asset paths; **convert icon names to Lucide** (Blume is Lucide-only — no FontAwesome/Tabler).
   6. Adopt `package.json`: `dev`/`build`/`start` → `blume dev`/`blume build`/`blume preview`; remove old framework deps; add `blume`.
   7. Verify: `blume build` (validates links, anchors, frontmatter schema, duplicate routes) then `blume dev` for visual review. Report everything dropped or approximated.
3. **The Blume mental model** (what "our navbar/sidebar works differently" means):
   - **Navigation is derived from the filesystem** — folders → groups, files → pages; ordering = `meta.ts` `pages` array → frontmatter `sidebar.order` → numeric filename prefix → alphabetical; `index` first. Explicit `navigation.sidebar` config replaces the whole tree — use it only when a source nav genuinely can't be expressed via files. This is the #1 idiom shift from Mintlify (where navigation is fully config-declared).
   - **Tabs scope the sidebar** (`navigation.tabs` = `{label, path, icon?}`; a route under a tab's path shows only that folder). One folder per tab.
   - **Selectors** (`navigation.selectors`, kinds dropdown/product/version/language) for whole-site partitions.
   - **Pathing/routes** — route = content path relative to `content.root`, numeric prefixes stripped, `(group)/` folders add no segment, `index` files map to the folder route, `slug` frontmatter overrides.
   - **`blume.config.ts` shape** — condensed field table (title/description/logo/banner, theme, navigation, content{root,sources,assets}, search, ai, mcp, openapi, redirects, seo, markdown, github, i18n, toc, lastModified, variables…) with the note that `{}` is valid and every field has defaults. Favicon is filename-convention (drop a `favicon.svg`/`.ico` in `public/`), not config. Point at `blume/schema` + `node_modules/blume/docs/configuration/`.
   - **Icons are Lucide, period** — bare Lucide names everywhere an icon is accepted (frontmatter `icon`, `sidebar.icon`, `meta.ts`, tabs, Card/Callout/etc.). Migrating sites must map source icon names (FontAwesome for Mintlify) to Lucide equivalents; where no counterpart exists, drop the icon and report it.
   - **Page frontmatter** — the strict schema (unknown keys are build errors): title, description, type, icon, sidebar{label,order,icon,badge,hidden}, seo{…}, search{…}, draft/hidden/noindex, slug. `title` renders as the H1 — bodies start at `##`, and any duplicated H1 in the source body must be removed.
   - **Authoring features** — `:::note|tip|warning|danger|info|success[Title]` directives (work in .md and .mdx), no-import MDX components (Card/CardGroup, Steps/Step, Tabs/Tab, Accordion/AccordionItem, FileTree/Tree, CodeGroup, Frame, ParamField/ResponseField/RequestField, Badge, Icon, Columns, TypeTable, …), ` ```package-install `, mermaid, math (opt-in), code-block titles/highlighting.
   - **OpenAPI** — `openapi: {enabled, sources: [{spec, label?, route?}]}` generates one real page per operation; never hand-migrate generated API pages.
   - **Redirects are static** — `redirects: [{from, to, status}]`; map old URLs when restructuring; dynamic patterns need external hosting config.
4. **Verification & reporting** — run `blume build`; iterate on diagnostics; end with a written summary of what was migrated, what was dropped (navbar CTAs, footers, custom theming, dynamic redirects, unmappable icons), and suggested follow-ups (`blume eject`/`blume add` for deep customization).
5. **Full documentation pointer** — `node_modules/blume/docs` (or `apps/docs/content/docs` in a repo checkout), naming the most relevant pages: `configuration/index.mdx`, `content/navigation.mdx`, `content/meta.mdx`, `content/syntax.mdx`, `content/components.mdx`, `reference/frontmatter.mdx`.

### references/\*.md content

Each file: detection fingerprint → config mapping table → nav mapping → frontmatter mapping → component/content transforms → icon conversion → framework-specific gotchas → dropped-feature list to report. **Mine `packages/blume/src/migrate/` for the exact mappings before deleting it** — the migrators encode hard-won knowledge. Key content per file:

- **mintlify.md** (deepest — source: `src/migrate/mintlify/*`):
  - `docs.json`/`mint.json` field map: `colors.primary/light/dark` → `theme.accent/accentDark/action`; `appearance` → `theme.mode/strict`; fonts → curated `theme.fonts` slugs (warn if unmatched); logo/banner pass through (banner: content/dismissible/id/link only — no color/type); favicon → copy the file(s) into `public/` under the conventional name (no config field); `seo.metatags`, `search.prompt`, `styling.latex` → `markdown.math`; `variables` → inline into content (no runtime `{{var}}` substitution).
  - **Icons**: Mintlify defaults to FontAwesome; Blume is Lucide-only. Convert every icon reference (frontmatter `icon`, nav group icons, `<Icon>`/`<Card icon>` usages) to the closest Lucide name — include a table of common FA → Lucide mappings (e.g. `bolt` → `zap`, `gear` → `settings`, `circle-info` → `info`, `wand-magic-sparkles` → `sparkles`, brand icons → drop or use social config) and the rule: verify the Lucide name exists, otherwise drop the icon and report it. `iconType` (solid/regular/brands) has no equivalent — discard.
  - Navigation: `navigation.{tabs,anchors,dropdowns,products,versions,languages,groups,pages}` → prefer restructuring content into folders + tabs; explicit `navigation.sidebar`/`selectors` only for shapes files can't express; `tag` → badge, `expanded` → inverted `collapsed`.
  - Content: `<Note>/<Tip>/<Warning>/<Info>/<Check>/<Danger>` → directives; `<AccordionGroup>/<Accordion title>` → `<Accordion>/<AccordionItem title>` (container/item inversion!); `<RequestExample>/<ResponseExample>` → `<CodeGroup>`; ParamField/ResponseField/RequestField work natively; snippets (`/snippets/*.mdx`) → inline them (Blume has no snippet imports); frontmatter `sidebarTitle/icon/tag/hidden` → `sidebar.{label,icon,badge,hidden}`.
  - OpenAPI: top-level/`api.openapi`/per-group `openapi` → `openapi.sources`; delete per-endpoint stub pages (`GET /path` frontmatter) — Blume generates them.
  - Assets: `/images` etc. → move to `public/` (Astro serves it at the site root; `content.assets` is being **removed** — see Part E1).
  - i18n: `navigation.languages` → `i18n.{defaultLocale,locales}`.
  - Dropped (report): `navbar.links/primary`, `footer.socials` (→ suggest `github` config), per-language banners, dynamic redirects, `<Update>` changelog component (→ `type: changelog` pages or `github-releases` source).
- **docusaurus.md** (written fresh): `docusaurus.config.js` themeConfig → theme/logo/navbar-tabs; `sidebars.js` (autogenerated → filesystem nav; explicit → folder restructure or `navigation.sidebar`); `_category_.json` → `meta.ts`; admonitions `:::note/tip/info/warning/danger` are already directive syntax (mostly passthrough; `caution` → warning); `<Tabs>/<TabItem>` → `<Tabs>/<Tab title>`; docs plugin `routeBasePath`, versioned docs (recommend migrating latest + `navigation.selectors` kind `version` if needed), blog plugin → `type: blog`, `@site/` import aliases, MDX v1 vs v3 pitfalls.
- **fumadocs.md**: `meta.json` → `meta.ts` (`defaultOpen` → inverted `collapsed`, `"..."` rest markers drop, `---Section---` separators → `(label)/` group folders, `[Text](url)` links → drop/report); `<Cards>` → `<CardGroup>`, `<Accordions>/<Accordion>` → `<Accordion>/<AccordionItem>`, `<Files>/<Folder>/<File>` → `<FileTree>` or `<Tree>`, `<Tabs items={[…]}>/<Tab value>` → `<Tab title>` per tab, `<include>` → inline; `loader({baseUrl})` → source `prefix`. Icons are already Lucide names — pass through.
- **nextra.md**: `_meta.{js,ts,json}` → `meta.ts` + frontmatter `sidebar.label`; folder titles live in the _parent_ `_meta` (propagate down); `type:"page"` → `navigation.tabs`; `display:"hidden"` → `sidebar.hidden`; `<Callout type>` → directives (`default` → note, `error` → danger); Bleed/Cards/FileTree/Steps/Tabs → Blume equivalents.
- **starlight.md**: `starlight({…})` in `astro.config.*` → config (title, logo light/dark, social → `github` config, `editLink.baseUrl` → `github`, sidebar autogenerate → filesystem, `expressiveCode.themes` → `markdown.codeBlocks.theme`, `head` → `seo.metatags`, `lastUpdated` → `lastModified`); `<Aside>` → directives (caution → warning); `<CardGrid>` → `<CardGroup>`, `<LinkCard>` → `<Card>`, `<TabItem label>` → `<Tab title>`; frontmatter `pagefind:false` → `search.exclude`, `prev/next:false` → `hideFooterPagination`; splash/hero templates → rebuild as custom Astro pages (`content/custom-pages.mdx`); `customCss`/component overrides → `theme.css` / `blume eject`; Starlight's built-in icon set → Lucide equivalents.

---

## Part B — Delete migrate + bridge

### Files to delete outright

- `packages/blume/src/cli/commands/migrate.ts`
- `packages/blume/src/migrate/` — entire directory (shared.ts, migrate.ts, mintlify/ ×9, fumadocs/ ×6, nextra/ ×4, starlight/ ×5)
- `packages/blume/src/core/bridge.ts`
- `packages/blume/src/core/sources/mintlify.ts`
- Tests: `packages/blume/test/{migrate,migrate-mintlify,migrate-fumadocs,migrate-nextra,migrate-starlight,migrate-shared,bridge-mintlify}.test.ts`
- Docs: `apps/docs/content/docs/advanced/bridge.mdx` (migrate.mdx is rewritten, not deleted — Part D)

Deleting `src/migrate/` wholesale also removes every migration-side consumer of the compat fields pruned in Part C (`mintlifyIcons`, `mintlifyBanner`, `mintlifyFavicon`, `mintlifyChromeVariants`, starlight favicon emit) — no pairing work needed there.

### Files to edit

| File | Change |
| --- | --- |
| `packages/blume/src/cli/index.ts` | Remove `migrateCommand` import (line ~11) + `migrate:` entry in `subCommands` (~32) |
| `packages/blume/src/core/config.ts` | Remove bridge imports (~3-4), `ConfigBridge` interface (~19-20), `bridge` result field (~31-32), detection block (~53-73), `sourceFile` fallback (~75), returned `bridge` (~117-120) |
| `packages/blume/src/core/project-graph.ts` | Remove `ConfigBridge` import (~2), `bridge` graph field (~73), destructure (~100), return (~182) |
| `packages/blume/src/cli/commands/dev.ts` | Remove the `if (project.bridge)` log block (~59-63) |
| `packages/blume/src/core/schema.ts` | Remove `mintlifySourceSchema` (~332-354) and its union entry (~380). (Compat-field prunes in Part C.) Keep `theme.background*` (generic; optional `backgroundDecoration` cut in Part E4). **`content.assets` is NOT generic — remove it (Part E1).** |
| `packages/blume/src/core/sources/resolve.ts` | Remove `mintlifySource` import (~10) + `type === "mintlify"` branch (~67-78) |
| `packages/blume/src/astro/generate.ts` + `templates.ts` | Comments only — replace "Mintlify bridge" examples with another staged source (e.g. openapi/notion). Do NOT touch the `staged`/`hasFilesystemSource` logic (shared by other sources) |

After deletion, grep for now-orphaned error codes (`BLUME_MINTLIFY_*`) and any lingering `bridge`/`migrate` imports. `BLUME_CONTENT_ROOT_MISSING` may be shared — verify before touching.

---

## Part C — Prune the Mintlify-compat surface

### C1. Icon system → Lucide-only

Lucide's render path stays exactly as-is (`@iconify-json/lucide` + `@iconify/utils` `getIconData`/`iconToSVG`, inlined SVG, zero JS) — that _is_ the direct-Lucide path. `theme/chrome-icons.ts` (hand-inlined chrome glyphs) and `simple-icons` (code-block language icons via `markdown/language-icon.ts`) are unrelated — untouched.

- `packages/blume/src/theme/icons.ts` — reduce to Lucide-only: `SETS` keeps only `lucide`; delete `LIBRARY_SETS`, `ICON_TYPE_SETS`, `PREFIX_SETS` FA/tabler entries (or prefix support entirely), `fromFaSet`, the `fa6-` branch in `resolveInSet`, the `iconType`/`library` branches in `setFor`, and `ResolveIconOptions.iconType`. Update header docblock.
- `packages/blume/src/components/Icon.astro` — drop `iconType` and `library` props (no caller passes `library`); simplify the `resolveIcon` call.
- Remove the dead `iconType` prop pass-through from `components/content/{Callout,Card,Badge,AccordionItem,Tab,Step}.astro` (Step also drops `{ iconType }` from its `hasIcon` call).
- `packages/blume/src/core/schema.ts` — delete `iconsConfigSchema` (~1004-1013) + `icons:` field (~1043), and the frontmatter `iconType` (~107).
- Config plumbing for `icons` — remove `astro/generate.ts:651` (`icons: config.icons`), `core/data.ts:97`, and the `data.config.icons.library` read in `Icon.astro`.
- `packages/blume/package.json` — remove `@iconify-json/fa6-brands`, `@iconify-json/fa6-regular`, `@iconify-json/fa6-solid`, `@iconify-json/tabler`. Keep `@iconify-json/lucide`, `@iconify/utils`, `@iconify/types`, `simple-icons`. Check the root `package.json` for mirrors of the removed deps (per the runtime-deps-mirror rule, `theme/icons.ts` resolves from the package so none expected).
- Tests: `test/theme.test.ts` — rewrite `resolveIcon default and explicit libraries` (~270-292) to Lucide-only; delete the `Font Awesome coverage` block (~294-336), porting any still-relevant `hasIcon`/prototype-safety assertions to Lucide names.

### C2. Orphan config fields

All validate-but-never-render (confirmed): nothing in the runtime reads them.

| Field | Schema location | Also touch |
| --- | --- | --- |
| `banner.color` + `bannerColorSchema` | `schema.ts` ~185-193, ~201 | `test/schema-coverage.test.ts` ~37-56 (banner-color refinement tests) |
| `banner.type` | `schema.ts` ~208-212 | — (docs never documented color/type) |
| `favicon` (top-level) + `faviconConfigSchema` | `schema.ts` ~175-183, ~1039 | Runtime already resolves by filename convention (`resolveFavicon` / `FAVICON_CANDIDATES` in `astro/generate.ts`); `data.config.favicon` in layouts is the _resolved_ value — leave alone |
| `navigation.chromeVariants` + `chromeVariantSchema` | `schema.ts` ~647-652, ~656 | `core/navigation.ts` (~349/366/380/388), `core/types.ts` (`NavChromeVariant`, `Navigation.chromeVariants` ~184-193), `core/graph.ts` (~92/108/115), `astro/generate.ts:618`; `test/nav-diagnostics.test.ts:11` |

`banner` itself stays (content/dismissible/id/link — rendered by `Banner.astro`; used by apps/docs).

Add a changeset (`.changeset/`) — minor bump — covering: `blume migrate`, bridge mode, and the `mintlify` content source removed (→ `blume-migrate` skill); `icons` config, `iconType`, and FontAwesome/Tabler support removed (Lucide-only); `banner.color`/`banner.type`, `favicon` config, and `navigation.chromeVariants` removed.

---

## Part D — Docs, homepage, packaging

### Docs content (`apps/docs/content/docs/`)

- **Rewrite `advanced/migrate.mdx`** — "Migrate to Blume" page for the skill flow: install with `npx skills use haydenbleasel/blume@blume-migrate`, run `/blume-migrate` in Claude Code (or point Codex at the SKILL.md), what the agent does (config translation, content restructure, component/directive rewrites, icon conversion to Lucide), what to review after. Works pre-install — the skill comes from GitHub, no `blume` dependency needed first.
- `advanced/meta.ts` — remove `"bridge"` from `pages` (keep `"migrate"`).
- `reference/cli.mdx` — remove the `blume migrate <tool>` row (~19).
- `index.mdx` — replace the Migration/bridge bullet (~52) with a skill-based one.
- `content/components.mdx` — rewrite the `## Icon` / `### Default library` section (~128-155) to Lucide-only: drop `iconType`, `fa6-solid:`/`tabler:` prefixes, and the `icons: { library: "fontawesome" }` example; also soften the Mintlify mentions (~155, ~462).
- `content/i18n.mdx` (~26), `configuration/index.mdx` (~190) — remove/retarget "migrating from Mintlify"/bridge mentions.
- Add a redirect `{ from: "/docs/advanced/bridge", to: "/docs/advanced/migrate" }` in `apps/docs/blume.config.ts`.

### Homepage (`apps/docs/pages/_home/Migrate.astro`)

Keep the interactive "Migrate from [Brand]" brand picker; rewrite the copy for agent-driven migration. Add a Docusaurus entry to the brand list. Per-brand `body` copy describes what the skill handles for that framework; the command box becomes the same one-liner for every brand: `npx skills use haydenbleasel/blume@blume-migrate`, with a caption to then run `/blume-migrate` in Claude Code. The copy-button plumbing (`data-blume-copy-install`) stays.

### Other references

- `README.md` — Migration bullet (~45) → skill-based; remove the `blume migrate` CLI table row (~57).
- `skills/blume/SKILL.md` — description mentions `(init, dev, build, migrate, eject)` and the "**Migration** — `blume migrate …`" bullet (line 57): update to reference the `blume-migrate` skill instead.
- `CLAUDE.md` module map — remove `migrate` migrators entry and the icons multi-library mention in `theme`; add a line noting `skills/` (agent skills, shipped in the package).
- `apps/docs/pages/_home/shared.ts` — drop the unused `migrate` icon if nothing references it after the rewrite.

### Packaging (ship `skills/`)

`skills/` lives at repo root; the package publishes from `packages/blume`. Mirror the existing docs-bundling pattern:

- Extend `packages/blume/scripts/bundle-docs.mjs` to also copy repo-root `skills/` → `packages/blume/skills/` (it already copies `apps/docs/content/docs` → `packages/blume/docs` on `prepack`).
- Add `"skills"` to the `files` array in `packages/blume/package.json`.
- Gitignore `packages/blume/skills` (generated copy, like `packages/blume/docs`).

---

## Part E — Main-bundle contamination surfaced by the git-history audit

_Added after auditing every Mintlify/bridge commit for changes that leaked into the **shipped runtime** — the "main bundle" every Blume user installs, i.e. all of `packages/blume/src` except the `src/migrate/` + `bridge.ts` + `sources/mintlify.ts` code Part B already deletes. Three findings change the plan above; the rest is confirmation that the plumbing is generic._

**Headline changes to the plan:**

1. **`content.assets` flips KEEP → REMOVE** (E1) — a self-contained ~160-LOC subsystem whose only auto-populator is the Mintlify migrator/bridge. Corrects lines 75, 106, and Verification #5.
2. **A batch of content components is deleted** (E2) — clean removals (`Warning`, `Panel`, `Tile`, `Tooltip`, `Columns`/`Column`, `Expandable`, `Visibility`) plus one real decision (the `ParamField` field family).
3. **More validate-but-unread compat fields join the Part C2 prune** (E3) — config `seo.metatags`/`search.prompt`/`variables` and eight frontmatter keys.

Everything else the audit checked is **generically correct — keep the code, only de-Mintlify the comments** (E5/E6).

### E1. `content.assets` — serving asset dirs outside `public/` → **REMOVE**

The user's flagged "accepting public files outside a `public/` path." `content.assets: string[]` (schema `schema.ts:389-395`) serves extra top-level dirs at the site root alongside `public/`. It's a real slice of shipped runtime, not just a field:

- `core/assets.ts` — whole file (`AssetMount`, `resolveAssetMounts`, ~31 LOC)
- `astro/static-assets.ts` — whole file (dev middleware `serveAssetMounts` + build copy `copyAssetMounts` + MIME table, ~124 LOC)
- `astro/integration.ts:6,10,81-84,121-126,146-152` (option + `astro:build:done` copy + `astro:server:setup` serve)
- `astro/templates.ts:7,319,321` (pipes `resolveAssetMounts(...)` into `blumeIntegration`)
- `core/links.ts:5,41-42,49-58,350-351,358` (link validation resolves `/images/x.png` against the mounts)
- `cli/commands/validate.ts:6,51`

**Why it's Mintlify-only:** origin commit `2727bfd` states it exists so `blume dev` in a Mintlify repo serves `/images/*` without moving files. The only writers are the two deleted subsystems (`migrate/mintlify/index.ts:180-185`, `bridge.ts:66-74`). The "auto-discover dirs referenced only by content" heuristic (`5fc39d4`) lives entirely in `migrate/mintlify/` and dies with it. Even the docs frame it as Mintlify-only (`configuration/index.mdx:190`: "mainly useful after migrating from a tool that serves assets from the project root (like Mintlify)").

**Why removal is safe:** Astro already serves `public/` at the site root, so the skill just `mv images/ public/images/` and every `/images/...` URL still resolves (the migrator's own pre-`2727bfd` behavior). Fresh Blume users start with `public/`; nothing else reads `content.assets`; `apps/docs` doesn't use it. Note the **decoupled** Notion/Sanity remote-image path is a _different_ module — `core/sources/assets.ts` `materializeAssets` → `.blume/public/blume-assets/` — and is unaffected.

**Removal footprint:** delete `core/assets.ts` + `astro/static-assets.ts`; `schema.ts:389-395` (field); `astro/integration.ts` (option 81-84, build-copy 121-126, serve 146-152, imports 6/10); `astro/templates.ts:7,319,321`; `core/links.ts:5,41-42,49-58,350-351,358` (drop `assetMounts` from `LinkContext`, simplify `assetIsPresent` to `public/`-only, drop the `validateLinks` option); `cli/commands/validate.ts:6,51`. Tests: delete `test/static-assets.test.ts`; strip asset assertions from `test/{integration,links,templates}.test.ts`. Docs: `configuration/index.mdx:180-190` (row + example) and `content/syntax.mdx:98`. Skill `mintlify.md`: "move root asset dirs into `public/`" (not "keep in place via `content.assets`").

### E2. Content-component prune — delete the Mintlify-compat shims

The component registry is maintained in **five** parallel places (the earlier plan assumed two) — every removal must touch all that apply, or typecheck/build breaks on a stale import:

1. `astro/templates.ts` — catch-all: import block (~L962-998) **and** `components` object (~L1015-1054).
2. `components/BlumePage.astro` — a **second, parallel** public map (easy to miss; `1780373` patched it in parallel): imports (~L19-56) **and** object (~L72-108).
3. `core/builtin-tags.ts` — the `BUILTIN_MDX_TAGS` set (~L7-45); feeds the missing-component diagnostic.
4. `components/props.ts` — exported prop type, where one exists (~L11-71).
5. `apps/docs/content/docs/content/components.mdx` — the `##` demo section (already part of Part D's components.mdx rewrite).

…then delete the `.astro` file.

**Clean removals (no capability lost the skill can't reproduce):**

| Component | Why remove | Skill converts to |
| --- | --- | --- |
| `Warning` | Dead — in **no** registry, used nowhere; migrator already rewrites `<Warning>`→`:::warning`. **Deleting the file is the entire change.** | `:::warning` |
| `Panel` | Mintlify styled aside; `data-blume-panel`/`right-rail-item` wired to nothing | `:::note` / `Frame` |
| `Tile` | Redundant image-led `Card` variant | `Card` |
| `Tooltip` | Mintlify-only inline hover chrome, unused | drop (minor loss) |
| `Columns` + `Column` | `Columns.astro` literally wraps `<CardGroup>` | `CardGroup` |
| `Expandable` | Literally wraps one `<AccordionItem>` | `AccordionItem` (see caveat) |
| `Visibility` | Half-implemented: the `for="agents"` half is unwired (no llms/AI pipeline reads it); self-demo only | drop |

Caveat: **`Expandable`** only goes if the field family (below) also goes — the API-fields docs note a `<ParamField>` "may nest `<Expandable>`" for sub-properties; if fields stay and Expandable goes, retarget that to `<AccordionItem>`.

**The one real decision — the field family `ParamField`/`ResponseField`/`RequestField`/`ApiField`** (commit `1780373`, literally titled "…compat components"): unambiguous 1:1 Mintlify shims, **but** the only way to document a single field (CLI flag, SDK arg, endpoint param) _inline in prose_. `TypeTable` documents a whole object and can't sit between paragraphs; the OpenAPI reference only covers real specs; the native renderer does **not** import them (no coupling — verified).

- **KEEP** (safe default): drop the "Mintlify-compat" framing in docs/comments, treat as Blume-native inline-field components. Cost: 4 files stay. Optionally simplify away the Mintlify `path`/`query`/`header`/`body` location-attribute convention → a plain `name`.
- **REMOVE** (matches the "as small as possible" goal): delete all four as a set + the components.mdx "API fields" section (~L460); skill converts `<ParamField>`/`<ResponseField>` → `TypeTable` rows (spec'd APIs → OpenAPI reference). Cost: a real regression for hand-written, prose-interleaved single-field docs. **This supersedes the "keep ParamField-style compat components" note in the old Verification #5.**

**Borderline KEEP:** `Frame` — the only Mintlify wrapper that adds real capability (caption/border/video-autoplay over a bare Markdown image); used in `migrate.mdx`.

**Out of scope (not Mintlify):** `Prompt` (Blume-native AI-prompt copy, self-demo-only — optional prune on its own merits). Genuinely core, **keep**: `Card`/`CardGroup`, `Tabs`/`Tab`, `Steps`/`Step`, `Accordion`/`AccordionItem`, `CodeGroup`, `FileTree`, `Tree`, `Callout` (**directive render target — must stay**), `Badge`, `Math`, `Diff`, `TypeTable`/`AutoTypeTable`, `YouTube`, `Color*`, `Component`, `CodeBlock`, `GithubInfo`, `Icon`, `ApiOverview`/`Operation`, `Update` (changelog timeline).

Add the removed components to the Part C changeset (breaking for anyone using `<Panel>`/`<Tile>`/`<Tooltip>`/`<Columns>`/`<Expandable>`/`<Visibility>` — and the field family if that path is taken).

### E3. More Mintlify-compat schema fields for the Part C2 prune

All validate-but-**never-read** (grepped every consumer outside migrate/bridge/mintlify.ts), all pinned by `git log -S` to the Mintlify PR `a481831`. Because `pageMetaBaseSchema` is `.strict()`, the frontmatter ones exist _only_ to stop a Mintlify page's frontmatter from erroring the scan. Add to the Part C2 table:

- **Config-level:** `seo.metatags` (`schema.ts:827`), `search.prompt` (`schema.ts:587`), `variables` + `variablesConfigSchema` (`schema.ts:486-488, 1056` — no `{{var}}` substitution exists in the runtime).
- **Frontmatter (`pageMetaBaseSchema`):** `sidebarTitle` (118 → superseded by `sidebar.label`), `tag` (120 → superseded by `sidebar.badge`; faceting reads `search.tags`, not `tag`), `mode` (111), `public` (113), `rss` (114), `hideApiMarker` (104), `hideFooterPagination` (105 → pagination renders unconditionally), `groups` (102), `keywords` (108).

Keep `deprecated` (99 — read by `core/navigation.ts`) and nav-config `tag` (421/437 — the selector/tab badge). Removing these turns a page carrying e.g. `keywords:` from "validates" into a build error — consistent with the "unknown keys are errors; convert don't preserve" philosophy, but the skill's `mintlify.md` must map each (`sidebarTitle`→`sidebar.label`, `tag`→`sidebar.badge`, the rest → drop/inline). `test/schema-coverage.test.ts` gains entries asserting they're now rejected.

### E4. Optional micro-cut — `theme.backgroundDecoration`

`theme.fonts` and `theme.background*` are **KEEP** (theme.fonts is an independent feature with **no** font deps — Astro self-hosts Google fonts at build time; the Mintlify font _mapping_ is migrator-only. `background*` render generically and are documented in `theming.mdx`; `apps/docs` uses none). The **one** field that's a verbatim Mintlify mirror is `backgroundDecoration` (`gradient|grid|windows`, `schema.ts:502`, rendered by `palette.ts:55-77,100,133,162`, docs `theming.mdx:117-121`) — its enum copies Mintlify's `background.decoration`. Optional to drop for maximum minimalism; keep `background`/`backgroundDark`/`backgroundImage*` (standard theming).

### E5. De-Mintlify comment sweep — **keep the code, fix the wording**

The audit confirmed the runtime plumbing added for bridge/migrated-Mintlify dev is **generically correct and stays** — it still fires for any all-staged-source project (notion/sanity/openapi/github-releases/mdx-remote), where `content.root` is effectively the project root. Only the comments name Mintlify. After Part B, retarget these to "an all-staged / root-rooted project":

- `core/sources/watch.ts:3-15` (docstring), `core/sources/filesystem.ts:83-90`
- `astro/templates.ts:377-382` (`server.watch.ignored`) + `~405-432` (`docsPattern`/`filesystem` param), `astro/generate.ts:976-979` (`hasFilesystemSource`)
- `core/meta.ts:41-43`, `core/types.ts:176` + `components/layout/NavSelector.astro:2` (selectors are a real feature), `core/graph.ts:63`

`cli/coalesce.ts` (dev-regeneration single-flight, OOM guard) and the `hasFilesystemSource` mechanism are pure generic robustness — **keep as-is**.

### E6. Confirmed KEEP (don't waste time here)

The redirect schema (`schema.ts:792-800`) carries **no** Mintlify-only shapes — wildcard/segment translation was migrate-side only (`migrate/mintlify/config.ts`, deleted); nothing to simplify. The `dot` i18n parser is a **general** feature (Mintlify migration uses the `dir` parser). Vite `fs.allow` workspace-root (`templates.ts:218`, commit `5b7e8ca`) predates all bridge work — a KaTeX/monorepo-hoisting fix, not a bridge artifact. Markdown/callout robustness (`directives.ts` empty-callout guard + formatted-label recursion), inline-code link masking (`normalize.ts`), and route-before-asset link checks (`links.ts`) are all generically correct — **keep all**. Directive aliases (`caution`/`error`/`important`/`warn` → callout types, `directives.ts:22-27`) are cross-framework vocab (Docusaurus/Nextra/Starlight), not Mintlify — **keep**.

### Size win (quantified)

| Removed | ~LOC |
| --- | --- |
| `src/migrate/` + `bridge.ts` + `sources/mintlify.ts` (Part B) | ~6,530 + 7 test files |
| `theme/icons.ts` FA/Tabler reduction (Part C1) | 183 → ~90 |
| 4 iconify deps (`fa6-brands`/`fa6-regular`/`fa6-solid`/`tabler`) | install-size |
| `content.assets` subsystem (E1) | ~160 (2 files) + wiring |
| Component shims (E2, excl. field family) | ~350 across 8 files |

(The `0897ca9` FontAwesome _synonym_ table is already gone — current `icons.ts` is 183 LOC with no synonym map — so C1's reduction is smaller than the raw diffstat implies.)

---

## Verification

1. `bun run check` and `bun run typecheck` — clean after deletions and the icon-system reduction.
2. `bun run test` — remaining suite green (7 migrate/bridge test files removed; `theme.test.ts`, `schema-coverage.test.ts`, `nav-diagnostics.test.ts` updated for the prunes).
3. `cd apps/docs && bun ../../packages/blume/bin/blume.mjs build` — docs site builds with the rewritten migrate page and Lucide-only components docs; no broken links to `/docs/advanced/bridge` (redirect in place). Do not run a build while a dev server is using `.blume/`.
4. `node packages/blume/scripts/bundle-docs.mjs` — confirms `packages/blume/skills/` is produced alongside `docs/`.
5. Grep sweep: `migrate`, `bridge`, `mintlifySource`, `BLUME_MINTLIFY_`, `iconType`, `fontawesome`, `tabler`, `chromeVariants`, `fa6-`, `content.assets`, `assetMounts`, plus the removed component tags (`Warning`/`Panel`/`Tile`/`Tooltip`/`Columns`/`Expandable`/`Visibility`) across `packages/blume/src` — nothing survives except: `theme.background*`, the `ParamField` field family **if** you took the KEEP path (E2), and the code whose only Mintlify tie is a comment (E5's de-Mintlify list — `watch.ts`, `filesystem.ts`, `templates.ts`, `generate.ts`, `meta.ts`, `types.ts`, `NavSelector.astro`, `graph.ts`), which should now read "all-staged/root-rooted project," not "Mintlify."
6. `content.assets` gone: no `resolveAssetMounts`/`serveAssetMounts`/`static-assets` references remain; `blume build` on a project that keeps images in `public/` still resolves `/images/*`.
7. Skill sanity check: `npx skills use haydenbleasel/blume@blume-migrate` against the pushed repo (or copy `skills/blume-migrate` into a scratch `.claude/skills/`) and confirm Claude Code lists `/blume-migrate`.
