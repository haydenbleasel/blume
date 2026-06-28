# Content sources (pluggable loaders)

## Goals

Today Blume is filesystem-first: content is a folder of `.md`/`.mdx` files, and
the filesystem is assumed end to end — from discovery, through the in-memory
graph, into Astro's content collection. This document plans **Path B**: a
first-class, pluggable content-source abstraction so a project can pull docs
from remote MDX, a CMS (Sanity), Notion, git, or any custom backend — and mix
several sources into one site, the way Fumadocs' `Source` model does.

This is the ambitious option. A lighter "sync remote content to disk, then run
the existing pipeline unchanged" approach (Path A) unlocks ~90% of the same
user-visible value at a fraction of the cost; it should ship first and is
forward-compatible with everything here. Path B is the destination once there is
real demand for native, well-modelled, live remote content.

Non-goals:

- Runtime/per-request content fetching. Blume stays build-time and static-first
  (see `00-vision.md`); sources are read at scan/build, not on every request.
- Replacing Astro as the renderer. Blume still owns the docs interpretation;
  Astro still renders.

## Where the filesystem is baked in today

The honest starting point. Two independent layers both assume disk:

**Layer 1 — Blume's own scan** (feeds the graph, nav, search, manifest, AI):

| Concern | Location | Coupling |
| --- | --- | --- |
| Discovery + read | `core/content.ts:152` `discoverContent()` — `glob()` + `readFile()` | hard |
| Folder meta | `core/meta.ts` `discoverFolderMeta()` — globs `_meta.*` | hard |
| Page model | `core/types.ts:64` `PageRecord.sourcePath` is intrinsic | hard |
| Orchestration | `core/project-graph.ts:41` `scanProject()` resolves a single `contentRoot` | hard |
| Paths | `core/project.ts` `resolveProjectContext()` — one absolute `contentRoot` | hard |
| Config | `core/schema.ts:154` `contentConfigSchema` — only `root`/`include`/`exclude`/`pages` | hard |
| Search index | `search/documents.ts:59` re-reads `page.sourcePath` | soft |
| Raw markdown / AI | `ai/markdown.ts:10` re-reads `route.sourcePath` | soft |
| Last-modified | `core/last-modified.ts` git-stats `sourcePath` | soft |
| Manifest | `core/manifest.ts:23` carries `sourcePath` downstream | soft |

**Layer 2 — Astro's content collection** (does the actual MDX render):

The generated `.blume/src/content.config.ts` uses Astro's built-in `glob()`
loader (`astro/templates.ts:251`), and the catch-all page renders through it:

```ts
// astro/templates.ts:667 — the catch-all [...slug].astro
const entry = await getEntry("docs", entryId);
const { Content, headings } = await render(entry);
```

`getEntry`/`render` come from `astro:content`, which is populated by the `glob`
loader. **This is the real constraint of Path B**: even after Blume's own scan
is source-agnostic, MDX-with-components still compiles through Astro's
filesystem-bound collection. Decoupling Layer 2 is the hard, Astro-specific part
and drives the rendering strategy below.

## The `ContentSource` interface

The core abstraction. A source is an object that can enumerate normalized
entries and (optionally) watch for changes. It never exposes a filesystem path
as identity — it exposes an opaque `ref` it knows how to read back.

```ts
// core/sources/types.ts (new)

/** A single content item, normalized by a source adapter. */
export interface SourceEntry {
  /** Source-local stable id, e.g. "api/auth" or a CMS document id. */
  ref: string;
  /** Logical route input; defaults to `ref` if omitted. May include slashes. */
  slug?: string;
  /** Frontmatter-equivalent metadata, validated against the Blume meta schema. */
  data: Record<string, unknown>;
  /**
   * The renderable body. Adapters normalize everything to Markdown/MDX *text*
   * so Blume's component set (Callout, Tabs, …) keeps working. Structured
   * sources (Notion blocks, Sanity Portable Text) convert to MDX here.
   */
  body: { format: "md" | "mdx"; text: string };
  /** Optional provenance for "edit this page" and last-updated. */
  editUrl?: string;
  lastModified?: string;
  /** Content hash for cache invalidation / HMR; adapter-computed when cheap. */
  hash?: string;
}

export interface ContentSource {
  /** Unique, stable name; used for namespacing and diagnostics. */
  readonly name: string;
  /** Pull every entry. Called once per scan. */
  load(ctx: SourceContext): Promise<SourceEntry[]>;
  /**
   * Optional: notify on change in dev. Returns a disposer. Filesystem uses
   * fs.watch; remote uses polling/webhook/SSE; static sources omit it.
   */
  watch?(ctx: SourceContext, onChange: () => void): () => void;
  /** Optional: read a single entry's body lazily (search/AI/raw export). */
  read?(ref: string, ctx: SourceContext): Promise<string>;
}

export interface SourceContext {
  projectRoot: string;
  /** Per-source cache dir under `.blume/cache/<source>/`. */
  cacheDir: string;
  mode: "dev" | "build";
  logger: Logger;
}
```

Key decisions encoded here:

- **Adapters normalize to Markdown/MDX text.** Rather than invent a universal
  AST, every adapter lowers its native shape (Portable Text, Notion blocks,
  remote HTML) to MDX source. This is the single contract that lets Blume's
  existing markdown processors (`markdown/index.ts`) and component set apply
  uniformly, and it side-steps most of the Layer-2 problem.
- **`ref`, not `sourcePath`.** Identity is opaque. Filesystem's `ref` happens to
  be a relative path; a CMS's `ref` is a document id.
- **Lazy `read()` is optional.** If an adapter can cheaply re-read one entry,
  the soft consumers (search, AI, raw export) use it; otherwise they fall back
  to the `body.text` already captured during `load()`.

## Configuration

`content` grows a `sources` array. A single discriminated union keeps it typed
and validated in `core/schema.ts`. The existing `root`/`include`/`exclude` keys
desugar to one implicit filesystem source, so **nothing breaks**.

```ts
import { defineConfig } from "blume";

export default defineConfig({
  content: {
    sources: [
      // Local docs (the default if `sources` is omitted)
      { type: "filesystem", root: "docs", include: ["**/*.{md,mdx}"] },

      // Remote MDX from a GitHub repo, mounted under /sdk
      {
        type: "mdx-remote",
        prefix: "sdk",
        url: "https://raw.githubusercontent.com/acme/sdk/main/docs",
        include: ["**/*.mdx"],
      },

      // A Sanity dataset, mounted under /guides
      {
        type: "sanity",
        prefix: "guides",
        projectId: "abc123",
        dataset: "production",
        query: `*[_type == "guide"]`,
      },

      // A Notion database, mounted under /handbook
      {
        type: "notion",
        prefix: "handbook",
        database: process.env.NOTION_DB_ID,
        // token via NOTION_TOKEN env var, never inlined
      },
    ],
  },
});
```

Schema sketch (`core/schema.ts`):

```ts
const filesystemSourceSchema = z.object({
  type: z.literal("filesystem"),
  prefix: z.string().optional(),
  root: z.string().default("docs"),
  include: z.array(z.string()).default(["**/*.{md,mdx}"]),
  exclude: z.array(z.string()).default(["**/_*", "**/.*"]),
});

const contentConfigSchema = z.object({
  defaultType: z.string().default("doc"),
  pages: z.string().default("pages"),
  // Back-compat: top-level root/include/exclude still accepted and desugared.
  root: z.string().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  sources: z.array(contentSourceSchema).optional(),
}).strict();
```

**Composition rules** (new logic in the graph builder):

- Each source gets an optional `prefix`; its routes are namespaced under it.
- Route collisions across sources are a build diagnostic (`BLUME_ROUTE_DUP`),
  reusing the existing duplicate-route machinery in `core/graph.ts`.
- Folder-meta (`_meta.*`) stays a filesystem-source concept; other adapters
  express ordering/labels via their own metadata mapped into `SourceEntry.data`.

## Decoupling the core (Layer 1)

1. **`PageRecord`** (`core/types.ts:64`): replace `sourcePath: string` with

   ```ts
   source: { name: string; ref: string };
   /** Body captured at scan time, so soft consumers need no re-read. */
   body?: { format: "md" | "mdx"; text: string };
   ```

   `id` stays the stable key but becomes `"<source>:<ref>"` to guarantee
   uniqueness across sources.

2. **`discoverContent`** (`core/content.ts:152`) becomes the **filesystem
   adapter** (`core/sources/filesystem.ts`) implementing `ContentSource`. The
   parsing helpers (`mapRoute`, `extractHeadings`, `extractLinks`, `deriveTitle`,
   frontmatter validation) move to a shared `normalizeEntry()` that every adapter
   funnels its `SourceEntry`s through — so route mapping, heading/link
   extraction, and meta validation are identical regardless of origin.

3. **`scanProject`** (`core/project-graph.ts:41`): instead of one
   `discoverContent` call, build the source list from config, run every
   `source.load()` in parallel, normalize, then concatenate into the page set
   the graph is built from. The `contentRoot`-exists check becomes a per-source
   `validate()`.

4. **Soft consumers**: route every `readFile(page.sourcePath)` through
   `source.read(ref)` (or `page.body.text`):
   - `search/documents.ts:59`
   - `ai/markdown.ts:10`
   - `core/last-modified.ts` (git source only applies to the filesystem adapter;
     other adapters supply `lastModified` directly on the entry)
   - `core/manifest.ts:23` carries `source`/`ref` instead of `sourcePath`.

## Decoupling the renderer (Layer 2)

This is the crux. Three strategies, in increasing order of architectural purity:

### Strategy 1 — Materialize to a staging dir (pragmatic, ship first)

Each non-filesystem adapter writes its normalized MDX into
`.blume/content/<source>/…`, and the generated `content.config.ts` points
Astro's existing `glob()` loader at `.blume/content` (plus the real filesystem
roots). Astro's MDX integration then renders everything — components and all —
with **zero changes to Layer 2**.

This is essentially Path A reused as Path B's render path. It keeps full
MDX-with-components fidelity for every source, which is the main reason to prefer
it initially. The cost is a write step and a `.blume/content` that must be
regenerated alongside the rest of `.blume/` (note the existing constraint that
`dev` and `build` share `.blume/` — staging must respect that).

### Strategy 2 — Custom Astro Content Layer loader (the architectural goal)

Astro 5's Content Layer API allows a custom loader object that populates the
collection store directly. Replace the `glob()` loader in
`contentConfigTemplate` (`astro/templates.ts:251`) with a generated
`blumeLoader` that reads Blume's already-scanned entries (serialized into a
generated module) and calls `store.set({ id, data, body, rendered })`.

```ts
// generated .blume/src/content.config.ts (Strategy 2)
import { defineCollection } from "astro:content";
import { blumeLoader } from "blume/astro/loader";
import entries from "./generated/source-entries.json";

const docs = defineCollection({ loader: blumeLoader(entries) });
export const collections = { docs };
```

Caveat to design around: a custom loader can store pre-rendered **HTML**
(`rendered.html`) or a Markdown **body** Astro will render — but **MDX with live
JSX components is not rendered by the custom-loader path** the way file-based MDX
is. So:

- Markdown bodies → store `body`; Astro renders normally.
- MDX bodies → either compile via `@astrojs/mdx` inside the loader and store the
  result, or fall back to Strategy 1 for entries whose `format === "mdx"`.

Because adapters normalize structured sources (Notion/Sanity) to Markdown where
possible, Strategy 2 covers them cleanly; MDX-heavy remote sources lean on
Strategy 1.

### Strategy 3 — Vite virtual modules

Expose each entry as a virtual `.mdx` module via a Vite plugin so Astro's MDX
pipeline compiles it without touching disk. Cleanest in theory, most invasive in
practice (interacts with Astro's content + Vite environments; see
`astro/templates.ts` `ssr/prerender/client` notes). Documented as a future
option, not a v1 target.

**Recommendation:** ship Strategy 1, migrate Markdown-normalizable sources to
Strategy 2 as the loader matures, keep Strategy 3 as research.

## Watching and dev

`cli/commands/dev.ts:40` currently watches a fixed list of absolute paths with
`fs.watch`. Generalize it: each source contributes its own `watch()`.

- **filesystem**: today's `fs.watch(contentRoot, { recursive: true })`.
- **mdx-remote / sanity / notion**: polling on an interval, a webhook endpoint
  in server mode, or a manual `blume sync` trigger. Remote watching must be
  opt-in and rate-limited — never refetch an entire Notion workspace on every
  keystroke.
- **static** (one-shot fetch): no `watch`; content is frozen for the session.

A debounce + per-source incremental re-scan replaces the current "re-scan
everything" `regenerate()`. Caching (below) makes remote re-scans cheap.

## Caching and incrementality

Remote sources need a snapshot cache so dev restarts and rebuilds are fast and
offline-tolerant:

- `.blume/cache/<source>/` holds the last fetched entries + ETag/cursor.
- Adapters report `hash` per entry; unchanged entries skip re-normalization and
  re-render (HMR stays surgical).
- A `--no-cache` / `blume sync --force` escape hatch for stale CMS content.
- Cache lives under `.blume/` and is regenerated, never committed.

## Adapters

Shipped as separate optional packages so their SDKs aren't forced on every
project (mirrors the search-provider pattern in `astro/templates.ts:331`, where
only the configured backend is bundled). Runtime deps the generated `.blume/`
imports must also be mirrored in root devDependencies so they hoist.

| Adapter | Package | Native shape → MDX |
| --- | --- | --- |
| filesystem | built-in | the current pipeline |
| mdx-remote | `@blume/source-mdx-remote` | fetch raw `.md(x)` over HTTP/git; pass through |
| sanity | `@blume/source-sanity` | GROQ query → docs; Portable Text → MDX |
| notion | `@blume/source-notion` | database → collection; blocks → MDX |
| git | `@blume/source-git` | sparse-checkout a repo subdir → filesystem adapter |

### Notion adapter (deep dive)

Notion is the most interesting non-text source and a strong differentiator —
teams that write internal docs in Notion get a real docs site for free.

Mapping:

- **Database → collection.** Each row/page is a `SourceEntry`. The Notion page
  id is the `ref`; a `Slug` property (or the title, slugified) is the `slug`.
- **Properties → frontmatter.** Map known Notion property names to Blume meta
  (`Title`→`title`, `Description`, `Order`→sidebar order, `Group`→nav group,
  `Status`→`draft` when not "Published", `Icon`→sidebar icon). Unknown
  properties pass through into `data` for theme use.
- **Blocks → MDX.** Convert the block tree to MDX with a library like
  `notion-to-md` or `@tryfabric/martian`, then map Notion constructs to Blume
  components: callout blocks → `<Callout>`, toggle → `<Accordion>`, code →
  fenced code (language preserved), columns → `<Columns>`/`<Column>`, bookmark →
  card. This reuses the exact components the markdown processors already emit.
- **Assets.** Notion image URLs are signed and expire. The adapter must
  download images at scan time into the project's asset pipeline and rewrite
  src — otherwise builds rot. This is the single biggest correctness hazard and
  needs explicit handling + a diagnostic when a fetch fails.
- **Auth & rate limits.** `NOTION_TOKEN` from env (never inlined into config or
  generated output). Notion's API is paginated and rate-limited, so the cache
  layer is mandatory, not optional — full re-fetch only on `blume sync --force`.
- **Drafts/preview.** `Status != Published` maps to `draft: true`, which the
  existing dev/build draft handling (`project-graph.ts:70`) already filters from
  production.

### Sanity adapter (notes)

- `@sanity/client` + a configurable GROQ query select documents.
- Portable Text → MDX via `@portabletext/to-html` (then wrap) or a direct
  Portable-Text→MDX serializer, mapping custom block/mark types to Blume
  components through user-supplied serializers.
- Sanity's `apiVersion`, `dataset`, `perspective` (published vs previewDrafts)
  surface as config; `previewDrafts` powers a future preview mode.
- Cross-references and image assets resolve through Sanity's CDN; like Notion,
  images should be materialized for static builds.

### mdx-remote adapter (notes)

The simplest: fetch raw `.md`/`.mdx` from a URL base or a git ref, pass the text
straight through `normalizeEntry()`. Because the body is already MDX, it renders
best via Strategy 1 (staging) until the custom loader handles MDX. Good for
"docs live in another repo" and monorepo-sibling scenarios.

## Back-compat and migration

- No `sources` key → synthesize one `{ type: "filesystem" }` from the existing
  `root`/`include`/`exclude`. Existing projects are untouched.
- `PageRecord.sourcePath` removal is internal; the public manifest gains
  `source`/`ref` and keeps `sourcePath` populated for filesystem entries during
  a deprecation window so `eject` and tooling don't break.
- `blume eject` (`registry/eject.ts`) must still produce a working Astro
  project; for non-filesystem sources it ejects the materialized staging content
  plus the generated loader.

## Risks and open questions

- **MDX-with-components from non-file sources** is the central unsolved tension
  (Layer 2). Strategy 1 sidesteps it; the custom loader only fully solves it for
  Markdown bodies. Worth prototyping early to confirm the boundary.
- **Asset durability** for remote sources (expiring Notion/Sanity URLs) — must
  materialize, with clear diagnostics on failure.
- **Build determinism / offline builds** — a CMS outage shouldn't fail CI; the
  cache should serve last-known-good with a warning.
- **Secrets** — tokens via env only; never serialized into `.blume/` or the
  manifest.
- **Route ownership** across sources — prefix conventions vs. explicit nav
  config; how `_meta`-style ordering generalizes beyond the filesystem.
- **Dev ergonomics for remote** — polling vs. webhooks vs. manual `blume sync`;
  what "HMR" means when the source is a database.
- **Link/asset validation** (`03-content-pipeline.md`) across sources — internal
  links may cross source boundaries.

## Phasing

1. **Refactor to the interface (no new behavior).** Extract the filesystem
   adapter, introduce `ContentSource`/`SourceEntry`, decouple `PageRecord` from
   `sourcePath`, route soft consumers through `read()`/`body`. Existing tests
   stay green. This is the bulk of the risk and unlocks everything else.
2. **Config + composition.** `content.sources`, namespacing/prefixes, collision
   diagnostics, back-compat desugaring.
3. **mdx-remote adapter** via Strategy 1 (staging) — the cheapest proof that a
   second source works end to end.
4. **Custom loader (Strategy 2)** for Markdown bodies; keep MDX on Strategy 1.
5. **Sanity + Notion adapters**, caching layer, asset materialization, remote
   watch.
6. **Preview modes, webhooks, eject support, docs.**

A realistic estimate for a clean Path B is ~1–2 weeks of focused work, with
phase 1 carrying most of the risk; phases 3–5 are largely additive per adapter.
