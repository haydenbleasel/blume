# Mintlify → Blume migration example

A small Mintlify project (a `docs.json`, root-level MDX pages, snippets, and
`logo/`/`favicon.svg` assets) used to exercise `blume migrate mintlify`. It
mirrors the Mintlify starter layout so the migration covers config translation,
snippet inlining, component rewrites, frontmatter mapping, and asset relocation.

## Migrate it

From this directory:

```bash
blume migrate mintlify
```

That converts `docs.json` into `blume.config.ts`, rewrites every page to
idiomatic Blume MDX in place (content stays at the project root), moves `logo/`
and `favicon.svg` into `public/`, and inlines `snippets/`. Then run:

```bash
blume dev
```

## What converts automatically

- `docs.json` → `blume.config.ts` (theme, navigation, navbar, footer, banner,
  SEO, redirects, …).
- Mintlify snippets (`<Snippet />` imports, `{variable}` interpolation, and
  `{{global}}` substitution) are inlined.
- Mintlify callouts (`<Note>`, `<Warning>`, `<Callout type="…">`, …) become
  `:::` directives; `<RequestExample>`/`<ResponseExample>` become `<CodeGroup>`.
- Page frontmatter (`sidebarTitle`, `icon`, `noindex`, `canonical`, …) folds
  into Blume's shape.

Most Mintlify components (`Card`, `Tabs`, `Steps`, `Accordion`, `Frame`,
`Tooltip`, `Tree`, …) have direct Blume equivalents and need no changes. The
migration prints warnings for anything that needs manual review — for example
API components (`ParamField`/`ResponseField`), which Blume renders from an
OpenAPI spec via its Scalar reference instead.
