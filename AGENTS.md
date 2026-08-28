# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

Blume is a zero-config documentation site generator: users drop Markdown/MDX in a folder, and the `blume` CLI generates and drives a **hidden Astro project in `.blume/`** (dev server, static build, search, OG images, theming). `blume eject` turns that into a standalone Astro app. Zero-config mode is a permanent, first-class design goal — never treat it as a stepping stone to "real" configuration.

## Repository map

| Path | What it is |
| --- | --- |
| `packages/blume` | The published npm package: CLI, Astro runtime, components, core logic. |
| `apps/docs` | The dogfooded docs site (useblume.dev). Content lives in `apps/docs/content/docs`. |
| `packages/video` | Remotion project for launch/marketing videos. Excluded from `build`. |
| `skills/` | Agent skills shipped with the package (`blume`, `blume-migrate`, `blume-update-docs`). Judgment-heavy workflows (like migration) ship as skills; mechanical checks ship as CLI commands. |
| `patches/` | Bun `patchedDependencies` (currently `oxfmt` — see Gotchas). |
| `plans/` | Working design notes; not shipped. |

Within `packages/blume/src`: `cli/` (Node-side CLI, the only part bundled to `dist/`), `core/` (config, content, navigation, schema), `astro/` (integration), `components/`, `runtime/`, `search/`, `og/`, `openapi/`, `translate/`, `audit/`, `theme/`.

## Toolchain and commands

Bun is the package manager (`bun install`, version pinned in `package.json#packageManager`); Turbo orchestrates workspaces. Node ≥ 22.12 is required at runtime.

From the repo root:

```bash
bun run check          # lint + format check (ultracite → oxlint/oxfmt)
bun run fix            # auto-fix lint/format
bun run typecheck      # tsgo --noEmit across workspaces
bun run test           # bun test via turbo
bun run test:coverage  # tests with the coverage gate (what CI and pre-commit run)
bun run build          # builds everything except packages/video
```

In `apps/docs`, scripts are the Blume CLI itself: `blume dev`, `blume build`, `blume check`, `blume audit`, plus `playwright test` for e2e.

- **TypeScript is pinned to `^6.0.3`. Never bump to 7** — the Go rewrite has no JS API (`ts.sys` is gone) and Blume's tooling depends on it. Speed comes from `tsgo`, not a TS upgrade.
- **Never run `npx oxfmt` or `npx oxlint`.** The repo patches `oxfmt` (fence/directive preservation); `npx` resolves an unpatched copy that mangles `:::` directives. Always use `bun run check` / `bun run fix`. If oxlint fails with ENOENT, run `bun install` and retry.
- The husky pre-commit hook runs `check`, `typecheck`, `test:coverage`, and the blume build — **commits take minutes**. Use generous timeouts (600s) when committing from a tool; a hanging commit is usually the suite, not signing.

## Testing and coverage

- `packages/blume` enforces **100% line and function coverage, per file**, via `bunfig.toml` — but only under `--coverage`. `bun test` alone won't tell you the gate fails.
- Branches guarded by environment variables need tests that explicitly set **and delete** the variable, or local coverage diverges from CI.
- `Intl.Segmenter`/ICU behavior differs between macOS and Linux (e.g. what counts as word-like). Cover tokenizer branches with rule-based inputs (like a trailing U+200D), not locale-dependent characters, or CI will fail where local passes.
- For dev/build e2e tests, reuse the helpers in `test/configured-integrations.test.ts`. Known flake patterns: double config restarts, startup wedges, readiness fetches that hang, builds that never exit, pipe drains that never EOF after a kill. Never use fixed sleeps or bare drain awaits.
- Tests write fixtures to `os.tmpdir()` under `blume-*` prefixes; coverage ignores those paths already.

## Architecture rules

- **`.blume/` is shared state** between `blume dev` and `blume build`. Never run a destructive build or `rm -rf .blume` while a dev server is running against it.
- **Only `src/cli` ships as a Node bundle** (`dist/cli/index.js`); the Astro runtime ships as source. Node-side code must resolve package files with `packageRoot()` from `core/package-root.ts`, never `import.meta`-relative offsets — those break in the bundled CLI.
- **Front matter goes through `core/frontmatter.ts`.** Never `import matter from "gray-matter"` directly; the wrapper injects a js-yaml engine so js-yaml 4 consumers don't crash on the removed `safeLoad`.
- **Dependency mirroring:** `packages/blume/package.json` is the canonical dep list; the root manifest is tooling plus a short list of mirrors, each with one specific reason. Bun's isolated linker keeps Blume's deps in `packages/blume/node_modules`, and `.blume/node_modules` is a junction into that directory, so the generated `.blume/` project (`astro.config.mjs`, `app.css`, prerender chunks) resolves Blume's deps **without** root mirrors — don't add one for "the generated project imports it by name". The mirrors that exist are: (1) packages left as **bare imports in the Vercel server function bundle** (`@modelcontextprotocol/sdk`, `zod`, `ufo`, `html-escaper`, `sharp`, `@orama/orama`) — `@vercel/nft` traces from `apps/docs/dist/server/**` up to the repo root, never through `packages/blume/node_modules`, and drops misses **silently**, so the deployed function 500s while CI and warm-cache previews stay green; `blume build` audits the bundle, and `ls apps/docs/.vercel/output/functions/_render.func/node_modules` after a `VERCEL=1` build is the ground truth. (2) `astro`, because `apps/docs/tsconfig.json` and `apps/sandbox/tsconfig.json` `extends: "astro/tsconfigs/strict"` and Vite's tsconfig loader resolves that from the app directory upward. Optional peers the tests need (`algoliasearch`, `typesense`, …) live in `packages/blume` devDependencies, not at the root. After removing root deps, `bun install` leaves stale root symlinks behind — `rm` them before trusting a build as proof.
- **`bun add` cwd trap:** running `bun add` from the repo root lands Blume runtime deps in the root manifest, where hoisting hides the mistake until publish. `bun update <transitive>` can also promote transitives to root deps — fix by stripping the `bun.lock` entries and re-running `bun install`, not by keeping the root entry.
- **New top-level `blume.config` fields** must be wired through `core/schema.ts`, `core/config-input.ts`, and the templates, or the drift guard fails typecheck.
- On Vercel, header routes for prerendered pages must be main-phase `continue` routes emitted **before** `handle: filesystem` — routes after the filesystem handler only run in the miss phase and never fire for static pages.

## Docs

- Edit docs in `apps/docs/content/docs`. `packages/blume/docs` is a gitignored copy produced by `bundle-docs` — edits there are silently overwritten.
- Don't hardcode counts of growing lists ("three skills") in cross-links; let the page that owns the list enumerate it.
- Use American spelling everywhere: code, tests, docs (behavior, color, normalize).

## Git and release workflow

- **Commit and push directly on `main`.** Don't create feature branches unless explicitly asked.
- **Every user-facing fix gets a changeset** (`.changeset/*.md`, `"blume": patch`) in the same commit. Default to `patch`; reserve `minor` for meaningful new config/components/capabilities.
- **Changesets become the CHANGELOG — never put issue references in them.** Put `Resolves #N` in the commit message body instead so GitHub auto-closes the issue, then comment on the closed issue.
- Don't commit during creative iteration (videos, design work) — iterate in the working tree and commit only after sign-off.
- In PR comments and issues, attribute decisions plainly to the maintainer and verify factual claims before stating them; don't invent rationale.

## General style

- Prefer the literal fix that was asked for over speculative heuristics or conditional cleverness.
- Reproduce reported failures before adding dependencies or workarounds — several past reports (pnpm-strict resolution, dep-optimizer teardowns) traced to the reporter's environment, not Blume.
