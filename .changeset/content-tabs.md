---
"blume": patch
---

Add `inline` and `param` props to the `Tabs` component. `inline` renders borderless — a tab strip on a full-width rule with the content flowing beneath as prose — instead of the bordered box. `param` syncs the active tab to a URL query param instead of the hash; because each group owns its own `param`, several `Tabs` can share a page and every selection is deep-linkable (a link ending in `?install=windows` opens on that tab). Existing boxed, hash-synced `Tabs` and `CodeGroup` are unchanged.
