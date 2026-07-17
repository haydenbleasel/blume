---
"blume": patch
---

Add `search.popular` to curate the Cmd+K empty-state link list. When set, each `{ href, label, icon? }` entry replaces the default first-six sidebar pages — useful on multi-tab sites where sidebar order surfaces the wrong section. Each `href` is authored root-relative and picks up `basePath` automatically (external URLs pass through); `icon` takes a built-in icon name and defaults to a file glyph. Omit or leave empty to keep the sidebar fallback.
