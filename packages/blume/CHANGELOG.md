# blume

## 0.3.0

### Minor Changes

- 5115383: `blume build` gains deployment override flags — `--output static|server`,
  `--adapter vercel|node|netlify|cloudflare`, and `--base <path>` — that override
  the corresponding `blume.config.ts` deployment fields for one build (handy for CI
  matrices and previews). `--analyze` prints a client-JavaScript bundle report
  (each `_astro/*.js` chunk largest-first, plus the total) so you can catch
  weight regressions without extra tooling.
- 6f20875: Complete the **component override API**. `defineComponents` now supports:

  - **An `islands` group** — register interactive framework components for use in
    every MDX page (the config-file equivalent of the `islands/` folder), hydrated
    by default (`client: "visible"`).
  - **Hydration on overrides** — any `mdx` or `layout` override can take a
    descriptor `{ component, client, media }` and hydrate with a real Astro
    `client:*` directive (`load`/`idle`/`visible`/`media`/`only`).
  - **Path-string references** — reference a component by path
    (`Footer: "./components/footer.astro"`) instead of importing it.
  - **A friendly diagnostic** — Blume warns at build time when an override points
    to a React/Vue/Svelte component with no hydration mode (so it would silently
    render as dead static HTML).

  Overrides are read by statically analyzing `components.ts` (never executing it),
  so Blume can emit the static imports and hydration wrappers Astro needs. Imported
  components still work as before; the new forms are additive.

- 968d449: Export per-component prop types from `blume/components`, so you can type an
  override or wrapper against the built-in's contract:

  ```tsx
  import type { CalloutProps } from "blume/components";
  ```

  Types are provided for the content components (`CalloutProps`, `CardProps`,
  `CardGroupProps`, `BadgeProps`, `TabsProps`, `TabProps`, `StepsProps`,
  `StepProps`, `AccordionProps`, `ColumnsProps`, `FrameProps`, `TooltipProps`,
  `IconProps`, and more). Each is derived from the component with Astro's
  `ComponentProps`, so it can never drift from the real props.

- a18b0e4: Static builds now emit platform redirect files so hosts issue real HTTP
  redirects instead of only Astro's client-side redirect pages: `_redirects`
  (Netlify, Cloudflare Pages), `vercel.json` (Vercel), and a structured
  `blume-redirects.json` manifest for manual wiring. A `_redirects`/`vercel.json`
  you ship in `public/` is preserved. Server/adapter builds are unchanged (the
  adapter handles redirects natively).
- e2f7d90: `blume dev` gains `--content-dir <dir>` (scan a different content folder without
  editing `blume.config.ts`, applied to the initial scan and every hot regenerate)
  and `--debug` (verbose Astro/Vite logging for troubleshooting).
- 7b8f026: Blume's own diagnostics (invalid config, frontmatter, or content errors) now show
  in the browser error overlay during `blume dev`, not just the terminal — each
  with its code, file/line, fix hint, and docs link. The overlay updates on every
  save and clears on the next successful reload.
- 316d862: Add `--json` to `blume validate` and `blume doctor`. With the flag, diagnostics
  are emitted as a JSON document on stdout — each with `code`, `severity`,
  `message`, root-relative `file`, `line`/`column`, and `docsUrl`, plus a severity
  summary — for CI pipelines and editor integrations. Human output is suppressed so
  stdout stays parseable.
- 5afd8dd: `blume init` gains starter and workflow flags:

  - `--template docs|api|sdk|changelog` — scaffold from a starter (an OpenAPI
    reference, an SDK layout, or a changelog with a first entry) instead of the
    plain docs seed.
  - `--package-manager npm|pnpm|yarn|bun` — tailor the printed next-steps.
  - `--eject` — scaffold and immediately eject to a standalone Astro project, or
    (when dependencies aren't installed yet) guide you to `blume eject` after
    install.

- 624d797: Expose the full set of overridable **layout slots**. Alongside the existing
  `Header`, `Sidebar`, `Breadcrumbs`, `TableOfContents`, and `Pagination`, you can
  now replace `Layout` (the whole page shell), `Logo`, `Search`, `MobileNav`, and
  the three content-injection slots `PageHeader`, `PageFooter`, and `Footer` — the
  last three have no built-in and render nothing until you set them. Each override
  receives the same props as the built-in it replaces. Register them the same way
  as before:

  ```ts
  import { defineComponents } from "blume";
  import Footer from "./components/Footer.astro";

  export default defineComponents({ layout: { Footer } });
  ```

- 40ed2b8: Render `navigation.selectors`. Configured selectors (Mintlify-style partition
  switchers — product, version, or any grouped destinations) now appear as
  zero-JS dropdowns in the header, highlighting the option that matches the current
  route. Each item supports a label, path, icon, description, and tag. Previously
  selectors validated and built into the graph but nothing displayed them.
- c94bcb9: Add performance-budget enforcement to `blume build`. `--budget-js <kb>` and
  `--budget-css <kb>` measure the total client `_astro/*.js` / `*.css` a build
  ships and fail (exit 1) when it exceeds the cap — turning a documented budget
  into a real CI gate. Pairs with `--analyze` (the per-file report).
- 2f1e33d: Prune the orphan `blume.config.ts` fields that validated but nothing read:
  `navbar`, `footer`, `icons`, `contextual`, and `styling` (Mintlify-compat
  leftovers). They no longer silently no-op — setting one is now a config error, so
  the surface reflects what Blume actually does. The Mintlify/Starlight migrators
  stop emitting them; per-partition `chromeVariants` keep only their `banner`
  override. (Site footers are available via the `Footer` layout slot, and code
  icons via `markdown.code.icons`.)
- 80cde3d: Add React island hooks, importable from `blume/hooks`:

  - `useBlume()` — the site `config` + `navigation`.
  - `usePage()` — the current page's `route` + `title`.
  - `useSearch()` — query the configured search provider (`search`, `results`,
    `loading`); the provider client loads lazily on first use.
  - `useAskAI()` — stream answers from the grounded Ask AI endpoint (`ask`,
    `messages`, `loading`, `reset`).

  Islands hydrate independently, so `useBlume`/`usePage` read a compact JSON
  snapshot the layout serializes into the page (emitted only when the project ships
  React, so static sites pay nothing). Custom pages built with `PageLayout` opt in
  by passing a `clientData` prop.

- 16a7a15: Ship every built-in content component through `blume add`, not just the five
  layout slots. `blume add callout`, `card`, `card-group`, `code-group`, `badge`,
  `steps`, `step`, `tabs`, `tab`, `accordion`, `accordion-item`, `columns`,
  `column`, `frame`, `expandable`, `panel`, `tooltip`, `tile`, and `prompt` copy the
  component into your project as editable source (imports rewritten to `blume/*`),
  then print the `defineComponents({ mdx })` snippet to wire it back. The page
  `feedback` rating is also available (`blume add feedback`) via a new `Feedback`
  layout slot.
- 408d4ef: Add `blume/runtime` data helpers for custom pages. `getBlumeCollection(data,
query?)` selects content routes from `blume:data` — filtered by collection,
  locale, or path prefix, with drafts/hidden pages excluded and sorted by path — so
  building a custom index or listing is a one-liner. The new `<BlumePage>`
  component (`blume/components/BlumePage.astro`) renders a content entry's body
  inside a custom page with Blume's built-in MDX components already wired in, with
  `components` and `collection` props for the rest. The runtime data types
  (`BlumeData`, `BlumeRoute`, …) are re-exported from `blume/runtime` too.
- 944d2aa: Add a `toc` option to `blume.config.ts`. `toc: false` hides the on-this-page
  table of contents site-wide; `toc: { minHeadingLevel, maxHeadingLevel }` changes
  which heading levels it lists (default: H2–H3). Previously the range was
  hardcoded and the TOC couldn't be turned off from config.

### Patch Changes

- 9159662: Ground **Ask AI** in your docs. The `/api/ask` endpoint now retrieves the most
  relevant pages for each question — via the same lexical Orama index that powers
  search — and injects them into the model's system prompt, so answers stay tied
  to your content and cite the pages they draw from instead of relying on the
  model's own knowledge. The in-page island also forwards the current page, which
  is added to the context first and used to scope retrieval to that page's locale.
  Grounding turns on automatically with Ask AI for the gateway, OpenRouter, and
  OpenAI-compatible backends; **Inkeep** is left untouched since it runs its own
  retrieval. No new configuration or dependencies.
- 6d03896: Add a `blume check` command that type-checks the docs site with `astro check`.
  It regenerates the `.blume` runtime, syncs Astro's content types, then runs the
  checker against the project — using the project-root `tsconfig.json` when present
  so authored `pages/` are covered, not just the generated project. Exits non-zero
  on type errors, so it slots into CI as a `typecheck` script.
- 40c9256: Diagnostics now carry a `docsUrl` pointing at the page that explains them. Every
  mapped error/warning (config, frontmatter, meta, sources, links, deployment, …)
  prints a `docs: https://useblume.dev/docs/…` line, so a failing build links
  straight to the fix.
- 037191b: Config and frontmatter validation errors now point at a line and column, not just
  the file. `diagnosticsFromZod` locates the offending key in the source text
  (narrowing key-by-key so a nested field lands under its parent), so a bad
  `blume.config.ts` field or a mistyped frontmatter value reports e.g.
  `at content/docs/guide.mdx:4:3`.
- c0c998b: Warn early when an enabled feature needs a runtime secret that isn't set, so it
  surfaces at `blume dev`/`build` instead of failing at the first request in
  production. Covers Ask AI (`AI_GATEWAY_API_KEY`, or the provider's `apiKeyEnv`)
  and Mixedbread search (`MIXEDBREAD_API_KEY`). It's a warning, not a hard failure,
  since the value may live only in the deploy environment.
- afafbc1: Add an integration **fixture matrix** (`test/fixtures.test.ts`) that exercises
  whole projects through the core pipeline — nested navigation, broken links,
  invalid frontmatter (with line/column), a custom `.astro` page, a React island,
  and static-vs-server feature gating — so the pieces keep working together, not
  just in isolation.
- d81aebc: Add a dev-only hydration-mismatch hint. When React reports an island hydration
  mismatch, Blume follows it with a friendly pointer explaining the usual causes
  (non-serializable props, non-deterministic render) and linking to the islands
  guide. It's guarded by `import.meta.env.DEV`, so it's tree-shaken out of
  production builds.
- 085ed4d: Unexpected (non-`BlumeError`) failures now print a stable internal-error report —
  a fixed `BLUME_INTERNAL` code, the message, a trimmed stack, and an environment
  dump (Blume/Node/platform) with a link to file an issue — instead of a bare stack
  trace. Wired into `prepare`, `validate`, and `doctor`, plus a top-level backstop
  for async failures that escape a command (e.g. in `blume dev`).
- 18fb645: Catch unknown MDX components with a friendly warning before the build hits
  Astro's cryptic "Expected component X to be defined" error. When an `.mdx` page
  uses a `<Tag>` that isn't a built-in, an island, or a `components.ts` override,
  Blume warns with the page it's on and how to fix it — `blume add <name>` when a
  registry item matches, otherwise how to register or add it. Code blocks, inline
  code, and quoted text are ignored to avoid false positives.
- 7ae1937: Blume now warns when a navigation icon name (in `blume.config.ts`, folder meta,
  or a page's `sidebar.icon`) isn't in its icon set — a typo used to just render
  nothing. Image paths, URLs, and inline SVG icons are left alone. Surfaced by
  `blume dev`, `blume build`, and `blume doctor`.
- 7a8cd85: Blume now catches common navigation mistakes that used to fail silently:

  - **Missing target** — a tab/selector pointing at a route no page (content,
    custom `.astro`, or generated) serves.
  - **Duplicate labels** — two sidebar entries sharing a title at the same level.
  - **Hidden-in-sidebar** — a page marked `sidebar.hidden` that still appears in
    the sidebar (and therefore its prev/next pagination).

  Surfaced by `blume dev`, `blume build`, and `blume doctor`.

- f583299: Support custom `og:image` overrides on custom pages. `PageLayout`'s `ogImage`
  prop now resolves a root-relative path (a file in `public/`) against
  `deployment.site` to the absolute URL crawlers require; absolute URLs pass
  through unchanged. This lets a marketing home or landing page set a bespoke
  social image instead of the generated Open Graph card.
- 307e156: Add a Playwright end-to-end harness for the docs site (a real Blume project, so
  it doubles as the framework's browser coverage). `playwright.config.ts` builds
  and previews the site, and `e2e/site.spec.ts` drives navigation, the sidebar,
  theme toggle, the mobile drawer, the search dialog, code-copy, tabs, and a custom
  page. Run with `bun run test:e2e` (after `bunx playwright install`).
- e18dcc8: Redesign the generated Open Graph card. It now uses a light layout with a
  brand lockup (the configured `logo` SVG, painted to the foreground, or an accent
  tile with the site initial as a fallback), the page title as a balanced
  headline, the site description as a muted subtitle, and a footer showing the
  repository slug and site host. Titles and descriptions use `text-wrap: balance`.
- e66583c: Error reports now relativize `.blume/` stack frames. A frame pointing into the
  hidden generated runtime is shortened from its machine-absolute path to a
  project-relative `.blume/…` path tagged `(generated)`, so internal-error stacks
  stay readable and the user-source frames (custom pages, island/override
  wrappers, which keep their real paths) stand out.
- d59a1b0: Add accessibility and visual-regression coverage to the Playwright suite.
  `e2e/a11y.spec.ts` runs axe-core (WCAG 2 A/AA) on the home, docs index, and a
  content page, checks the skip link is first in the tab order, verifies dark-mode
  color contrast, and renders under reduced motion. `e2e/visual.spec.ts` captures
  light/dark screenshot baselines for regression diffing.

## 0.2.0

### Minor Changes

- 7a30708: Add a built-in `github-releases` content source that turns a repository's GitHub
  Releases into `type: changelog` entries, so your release notes become your
  changelog with no files to maintain. The generated `/changelog` timeline now
  also reads staged (non-filesystem) sources, and the CLI loads `.env`/`.env.local`
  (cascading to the repo root) before the content scan so remote sources can read
  tokens like `GITHUB_TOKEN`. Because a changelog is supplementary, a fetch failure
  with no cache (e.g. a CI build without a token) degrades to an empty timeline with
  a warning instead of failing the build, and the `/changelog` page is still
  generated so its nav tab resolves.

## 0.1.5

### Patch Changes

- 6eb10b8: Hide tab-owned groups from the root sidebar. On a route under no tab (or the
  root `/` tab), the sidebar showed every top-level group — including the folders
  that already have their own header tab — so a section like Adapters or API
  appeared both as a tab and as a sidebar group. Those tab-owned groups are now
  dropped from the un-scoped sidebar, leaving only the pages that don't belong to
  a tab (and any group emptied by this is dropped too). If hiding them would blank
  the sidebar, the full tree is shown, so a route is never left empty.

## 0.1.4

### Patch Changes

- a41a9d7: Insulate the `<Component>` live preview from the page's prose styles. The preview renders inside the content's `.prose` wrapper, so Tailwind Typography bled into the previewed component (heading sizes, link colors, list markers, paragraph spacing), making it look unlike its real rendering. The Preview pane now carries `not-prose`; the Code pane keeps prose so the highlighted source stays styled.
- a1155c4: Add a default 404 page. Blume now generates a not-found page at Astro's reserved `src/pages/404.astro` path, so static builds ship a `dist/404.html` and `blume dev` serves it for unmatched routes — previously an unknown URL fell back to Astro's unstyled default. The page renders through `PageLayout` (header + search, no sidebar), is centered and `noindex`, and its copy comes from new translatable `notFound` UI strings (`title`, `description`, `home`), overridable per locale via `i18n.ui`. Drop a `pages/404.astro` to replace it entirely: Blume skips the default when the project already owns `/404` (a custom page or a `404.md` content page), so the override never collides. The same default is written on `blume eject`.
- 875eac0: Navigation tabs now scope the sidebar to their section. Previously `navigation.tabs` rendered as header links but every page still showed one global sidebar; the `sidebarVariants` data the model carried was never consumed at render time. Now, when the current route falls under a tab's `path`, the sidebar shows only that tab's section (the folder at that path) — so a multi-section site (e.g. Adapters / API / AI tabs) drills each tab into its own pages, the way Fumadocs' root folders do. It needs no extra config beyond the tabs: each group carries its URL path, and the renderer picks the section matching the route, falling back to the full sidebar when no tab matches. Breadcrumbs and pagination follow the scoped tree.

## 0.1.3

### Patch Changes

- 46f539c: Let `<Component>`'s `examples` config be a glob, not just a directory. When it contains glob magic (`*`, `?`, `[]`, `{}`, or `!`), only matching files are discovered and a `<Component path>` key is relative to the glob's static prefix. This lets a shadcn-style registry that colocates each component's source (named exports, no default) with its example (default export) be targeted directly — e.g. `examples: "registry/<pkg>/**/examples/*"` previews just the examples instead of sweeping in the sources and failing the build with `"default" is not exported`. Also makes `blume eject` honor the configured `examples` directory, which it previously ignored.
- 84ef03c: Stop the search preflight from falsely warning `Search provider "orama" needs "@orama/orama", which isn't installed` on a successful build. The check resolved the provider SDK from the project root only, so under isolated linkers (Bun's `isolated` mode, pnpm) a SDK Blume ships — Orama, the default provider — looked missing even though the index built fine via the `.blume` deps link. It now also resolves from Blume's own package (the same dependency set the build uses), so a shipped SDK is recognized; a genuinely uninstalled peer (Algolia, Typesense, …) still warns.

## 0.1.2

### Patch Changes

- b6a2506: Surface a clear, actionable diagnostic for the split-layout Astro conflict that a symlink can't repair. When a hoisted install pulls a second Astro to the project root (e.g. a dependency with a type-only `astro@6`) that shadows Blume's, and `@astrojs/mdx` is hoisted away from Blume's own Astro, `ensureDepsLink` can't reconcile the split with one symlink and leaves it for a root `overrides`/`resolutions` pin. Previously it did so silently, and the build later crashed deep in Astro on a missing export (e.g. `chunkToString`) with no hint at the cause. `blume dev`/`build` now warn up front — naming the conflicting versions and telling you to pin Blume's Astro with a package.json `overrides` (npm/bun/pnpm) or `resolutions` (yarn) entry — and the warning clears itself once the pin is in place.
- 40c7bd7: Make `<Component>`'s examples directory configurable. `<Component path>` previously only resolved live previews (and their source) from a top-level `examples/` directory, so projects whose examples live elsewhere — e.g. a registry layout like `registry/<pkg>/…`, which also doubles as the shadcn payload — couldn't adopt it. Set `examples` in `blume.config.ts` to point at any directory under the project root (default `"examples"`); a `<Component path>` key is then relative to that directory. For example, with `examples: "registry/files-sdk"`, a file at `registry/files-sdk/file-list/basic.tsx` is `<Component path="file-list/basic" />`.
- b6a2506: Fix `blume build` failing under isolated package-manager linkers (Bun's `isolated` mode, pnpm) with `Cannot find package 'zod'` (or `shiki`, `sharp`, `@takumi-rs/core`, …) during static page generation. Astro's static build emits a self-contained SSR bundle to `dist/.prerender/` and runs it to render the HTML; that bundle leaves Blume's render-time dependencies external, so Node resolves them by walking up from `dist/.prerender/`. The earlier dependency-link fix only repaired resolution rooted at `.blume/`, and `dist/` is a separate tree an isolated linker never hoists Blume's deps into, so prerendering died. Blume now drops the same `node_modules` symlink beside the prerender bundle (removed again with `dist/.prerender/` once generation finishes, so nothing leaks into your published output), and forces Blume's render-time deps external on both build environments so an isolated linker doesn't bundle a symlinked store copy and strand one of its own transitive dependencies (e.g. `batchwork` via `@astrojs/markdown-satteri`) as an unresolvable import.

## 0.1.1

### Patch Changes

- 52fdcb4: Auto-detect an Apple touch icon by filename, the way favicons already work. Drop an `apple-icon.png` (or `.jpg`/`.jpeg`, or `apple-touch-icon.png`) in your project root or `public/` directory and Blume wires up `<link rel="apple-touch-icon">` for you — no config required. A file in `public/` is referenced by URL (the reliable path for iOS); there's no default, so no tag is emitted when the project ships none.
- ac174bd: Document and type the `blume:data` module that custom pages import. Export `BlumeData` (and its parts — `BlumeDataConfig`, `BlumeRoute`, `BlumeFeed`, `BlumeLogo`, `BlumeFavicon`, `BlumeBanner`, `BlumeDataI18n`, `UIStrings`) from `blume`, so a custom `.astro` page can `import type { BlumeData } from "blume"` instead of reading the generator to learn the shape. The generated runtime now declares `blume:data` with that type, and `buildRuntimeData` is annotated with it so the exported type and the emitted JSON can't drift. The custom-pages guide's data table is expanded to the full surface — `config` (now listing favicon/appleIcon/banner/theme/site/repoUrl/search/i18n/mcp/og/analytics/...), plus `navigation`, `navigationByLocale`, `routes`, `feeds`, `fontCssVars`, `ui`, and `uiByLocale`.
- 2a3acb7: Add a `CodeBlock` component and a `highlightCode` helper for themed code outside the Markdown pipeline. There was no way to highlight a string with Blume's configured Shiki theme except by writing a fenced code block, so showing code on a landing page or inside a custom component meant pulling in raw Shiki and hand-writing a `[data-theme="dark"]` swap. `CodeBlock` (usable in any MDX page, or imported from `blume/components/content/CodeBlock.astro`) renders a `code` string with the same themes, transformers, and light/dark swap as fenced code — `<CodeBlock lang="ts" code={source} />`. The underlying `highlightCode(code, lang)` is exported from `blume/markdown` for rendering to an HTML string directly. The `<Component>` source view now shares the same helper.
- fe75624: Add `<Component>` — render an example file from your project's `examples/` directory as a live, hydrated preview alongside its highlighted source, in tabs. Point it at a file with `<Component path="forms/login" />` (the path under `examples/`, without the extension); React, Vue, Svelte, and Astro examples are all supported.
- fe75624: Add `<Diff>` — render a git-style diff with `@pierre/diffs`, highlighted with the same Shiki theme as your code blocks and produced entirely at build time (no client JavaScript). Accepts two inline strings (`old`/`new`), two file paths (`before`/`after`), or a unified patch (an inline `patch` string or a `src` file).
- 0a147fb: Fix the Fumadocs `meta.json` → sidebar migration for the common flat-files-plus-separators layout. The Extract operator (`...folder`) is no longer kept as a literal `"...folder"` page slug; it now keeps the folder's place in the ordering and renders as a normal group. `---Section---` separators, which were previously dropped with a warning, are rebuilt as route-transparent Blume group folders: a section's flat pages move into a `(Section)/` folder (with a `meta.ts` preserving their order), a section that is a single folder is left in place, and links are reported for manual navbar placement. Routes are unchanged and per-folder `meta.ts` keeps working, since the migration reshapes the filesystem rather than emitting a global `navigation.sidebar` override.
- 6501d73: Repair `blume dev`/`build` when a hoisted install resolves the _wrong_ Astro. Previously `ensureDepsLink` only relinked Blume's deps when Astro was unresolvable from `.blume/` (isolated linkers, pnpm); if a sibling workspace pinned an older major (e.g. `astro@6` for a type-only import) and the package manager hoisted it to the project root, `.blume/` resolved that shadowing copy, `@astrojs/mdx@7` bound to it, and the build crashed on a missing export. The link decision now compares _which_ Astro resolves — Blume's own versus a shadowing one — and links Blume's dependency directory in whenever they differ, not just when Astro is missing. This only happens when Blume's deps are a co-located, consistent set (Astro beside the `@astrojs/mdx` that binds to it); a split layout, where the integration is hoisted away from a conflicting Astro, can't be fixed by one symlink and still needs a root `overrides`/`resolutions` pin, so it's left untouched rather than half-fixed.
- 49be339: Fix `blume dev`/`build` failing to resolve Astro and its integrations under isolated package-manager linkers (Bun's `isolated` mode, pnpm), which forced projects to redeclare Blume's dependencies by hand. The generated `.blume/` runtime now locates Blume's real dependency directory — whether nested under the package or installed as siblings in a virtual store — and symlinks it in, so the generated config's bare specifiers resolve without the project adding any deps. Stale or broken `.blume/node_modules` links are also detected and rebuilt.
- 6a06d82: Finish the Fumadocs migration teardown so the project builds as Blume without manual cleanup. After moving content and writing the config, `blume migrate fumadocs` now repoints the `dev`/`build`/`start` scripts at the Blume CLI (`blume dev`/`build`/`preview`) and drops the `fumadocs-mdx` postinstall, adds `.blume/` and `dist/` to `.gitignore`, and prints a "safe to delete" checklist of the leftover Next/Fumadocs files it found (`next.config.*`, `source.config.*`, `mdx-components.tsx`, `app/`, …) plus a reminder to remove the `next` tsconfig plugin and the `.next`/`.source` ignore lines. It also derives a better site title for monorepos: a generic package name like `web` (from `apps/web`) now falls back to the repository's directory name. (The script-rewrite, gitignore, and leftover-checklist helpers live in the shared migration toolkit for other migrators to adopt.)
- e6914c0: Generate Open Graph cards for custom pages, including the home. OG images were generated per content route only, so a custom landing page at `/` — the most-shared URL — got no `/og/index.png` and had to ship a static `public/og.png`. Blume now renders a card for every static, public custom page (skipping dynamic `[param]` routes and private `_partial`/`.well-known` segments): the home uses the site title with the site description as its eyebrow, and a deeper page is titled from its last path segment. `PageLayout` derives the page's `canonical` and `og:image` from `siteUrl` + `ogEnabled` automatically (explicit `ogImage`/`canonical` still override), so a custom page wired from `blume:data` gets a themed card with no extra work.
- e22d957: Add `PageLayout` for landing, marketing, and other full-width pages. `RootLayout` hard-codes the docs 3-column grid (sidebar + prose + TOC), so building a custom page like a landing page meant hand-rolling the entire document shell — re-importing the header/favicon/fonts, copying the theme + banner pre-paint scripts, wiring `fontCssVars`, and rebuilding the banner markup. `PageLayout` (import from `blume/components/layout/PageLayout.astro`) provides that shell — `<head>`, theme, fonts, favicon, banner, and header — then a single full-width `<slot />` for the body, plus an optional `footer` slot rendered after `<main>`. Props come straight from `blume:data`. The two layouts now share the theme/banner pre-paint scripts so they can't drift, and the bundled docs landing page is built on `PageLayout`.
- 9434520: Ship compiled `.d.ts` declarations for the public API so you can type-check your own Blume project. Previously the `blume` and `blume/schema` exports pointed straight at `src/*.ts`, so the moment a consumer's `tsc`/`tsgo` touched a file importing `blume` (`blume.config.ts`, every `meta.ts`, `components.ts`) it followed into Blume's source and surfaced errors it couldn't resolve — `.ts` import extensions (TS5097), `node:fs`, and migrator internals — forcing you to exclude your own config from type-checking. The build now emits declarations to `dist/types/`, and the exports map resolves the `types` condition to them while the runtime still resolves to source. `defineConfig`/`defineMeta` now type-check and autocomplete in editors without the source leaking.
- 482bd71: Wire the project's tsconfig `paths` into the generated runtime's Vite aliases, so `@/`-style imports resolve in `blume dev`/`build`. The generated `.blume/` is its own Astro project with its own tsconfig and never inherited the project's, so shadcn-style imports like `@/lib/utils` in custom pages, islands, and components failed to resolve and had to be rewritten to relative paths. Blume now reads `compilerOptions.paths` (and `baseUrl`) from the project's `tsconfig.json`/`jsconfig.json` — tolerating JSONC and following a relative `extends` to the file that declares them — and emits each mapping as a `resolve.alias` entry (longest prefix first), so those components port over unchanged. Reading is best-effort: an unparseable or alias-less config simply yields no aliases.
- 83aab31: Fix `blume validate` false-flagging valid heading anchors. Heading anchor ids were derived for the manifest with a hand-rolled slugifier that collapsed consecutive dashes (`--` → `-`) and didn't disambiguate repeated headings, while the renderer assigns ids with `github-slugger`. So a link like `/api/copy#the-read--write-fallback` (matching the real rendered id) was reported broken, and a link to a repeated heading's `#setup-1` had no match. Heading extraction now uses the same per-document `github-slugger` as the renderer, so the manifest's anchor ids — and the on-page table-of-contents links built from them — match the rendered heading ids exactly. (`slugify` still handles content/route slugs.)
- f412250: `blume validate` now treats configured redirects as valid link targets. A content link to a path that only exists as a `redirects` entry (e.g. `/providers`, which redirects to `/providers/openai`) was flagged as a broken link, even though it resolves at runtime. Link validation now accepts any link whose target matches a configured `redirect.from`, removing the false positive.
- 5e35945: Fix `blume dev`/`build` crashing with "Function yaml.safeLoad is removed in js-yaml 4" when a workspace resolves js-yaml 4 for gray-matter. Front-matter parsing now routes through an explicit js-yaml `load`/`dump` engine instead of gray-matter's removed `safeLoad` default.

## 0.1.0

### Patch Changes

- 2aa1da0: First alpha release (v0.0.1) for testing.
