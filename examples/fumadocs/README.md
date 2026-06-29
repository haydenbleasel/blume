# Fumadocs → Blume migration example

A small Fumadocs project — a `source.config.ts`, a `lib/source.ts` loader with a
`/docs` base URL, MDX pages under `content/docs/`, and per-folder `meta.json`
files — used to exercise `blume migrate fumadocs`. It mirrors the Fumadocs
starter layout so the migration covers route-prefix preservation, `meta.json`
translation, frontmatter normalization, and the MDX component rewrites
(`<Callout>` → directives, `<Cards>`/`<Accordions>`/`<Files>` → Blume
equivalents, and `<Tabs items>` → per-`<Tab>` titles).

Run it:

```sh
bun install
bun run migrate
bun run dev
```
