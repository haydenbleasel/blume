# Mintlify migration

## Goal

`blume migrate mintlify` is a one-time, in-place conversion: point it at a
Mintlify project (`docs.json`/`mint.json` + MDX) and it produces a real Blume
project the author owns. It is not a runtime bridge — Blume's dev/build pipeline
stays Mintlify-free; all the Mintlify knowledge lives in `src/migrate/mintlify`
and only runs during the migration.

```bash
cd my-mintlify-docs
blume migrate mintlify
blume dev
```

## What it does

The migrator (`src/migrate/mintlify/index.ts`) runs these steps:

1. **Config** — `loadMintlifyConfig` (`config.ts`) reads `docs.json` (resolving
   `$ref`s) and returns a full `BlumeConfig`: theme/colors/appearance,
   navigation (sidebar, tabs, selectors, chrome/sidebar variants), navbar,
   footer, banner, logo, favicon, search, SEO, styling, icons, redirects, and
   contextual menu. It is serialized to `blume.config.ts`. `navigation.languages`
   is additionally mapped to Blume's `i18n` (`i18n.ts`).
2. **Content stays at the project root.** The emitted config sets
   `content.root: "."` with Mintlify's ignore set (plus `.mintignore`), so page
   references keep resolving without rebasing.
3. **Per-page source rewrites** turn Mintlify MDX into idiomatic Blume MDX:
   snippets and `{var}`/`{{global}}` substitutions are inlined (`snippets.ts`),
   leftover markdown snippet imports are dropped and component snippet imports
   (`.jsx`/`.tsx`) are relativized (`content.ts`), inline-SVG icon props are
   stringified (`icons.ts`), `<RequestExample>`/`<ResponseExample>` become
   `<CodeGroup>`, callout components (`<Note>`, `<Callout type="…">`, …) become
   `:::` directives (a quote/brace-aware scanner handles JSX-expression
   attributes), and frontmatter (`sidebarTitle`, `icon`, `noindex`, `canonical`,
   `og:image`, …) folds into Blume's strict shape (`frontmatter.ts`).
4. **Assets** referenced by the config (`logo/`, `favicon.*`, `images/`) move
   into `public/`; the inlined `/snippets` markdown is removed.

Most Mintlify components (`Card`, `Tabs`, `Steps`, `Accordion`, `Frame`,
`Tooltip`, `Tree`, `Panel`, `Badge`, `Color`, …) already exist as Blume
components, so they migrate untouched.

## Design decisions

- **Translation layer, not a bridge.** The `docs.json` parser and the source
  rewriters are migration-only modules. The Blume runtime gains no Mintlify
  detection, CLI alias, or markdown plugins.
- **Full-fidelity config.** The config surface the migrator emits (navbar,
  footer, selectors, tabs, chrome/sidebar variants, contextual, styling, icons,
  background decoration, …) is backed by real Blume schema, navigation, and
  components — the migrated config renders, it does not just validate.
- **Idiomatic content.** Pages are rewritten to native Blume markup rather than
  shimmed; Blume's page frontmatter schema stays `.strict()`, so the migrator
  drops keys with no Blume home (reported as warnings).

## Known limitations (reported as warnings)

- API components (`<ParamField>`, `<ResponseField>`) have no Blume equivalent —
  use the OpenAPI reference (Scalar) instead.
- `docs.json` variables are inlined; Blume has no runtime variable substitution.
- Component snippets keep working via relativized imports but are flagged for a
  quick review.
