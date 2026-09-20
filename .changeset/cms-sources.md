---
"blume": minor
---

Add `contentful()`, `payload()`, and `strapi()` content source adapters to `blume/sources`. Each reads one content type or collection through the CMS's REST API — no SDK to install — maps its fields to frontmatter through the same `fields` option Sanity uses, and lowers its rich text body to Markdown: Contentful rich text (headings, marks, links, lists, quotes, tables, embedded assets), Payload's Lexical editor state (including check lists, uploads, and `block` nodes through serializers), and Strapi's Blocks field (including code blocks and images). A body held in a Markdown text field passes through as written.

`contentful()` declares `CONTENTFUL_ACCESS_TOKEN` and reads through the Preview API with `CONTENTFUL_PREVIEW_TOKEN` under `--preview`; `payload()` declares `PAYLOAD_API_KEY` and `strapi()` declares `STRAPI_API_TOKEN`, and both request drafts under `--preview` and stage them with `draft: true`. Relative upload paths resolve against the CMS origin, `params` appends extra query parameters (`where[...]`, `filters[...]`, `fields.section`), and `blume init` offers all three when asking where your content lives.
