---
"blume": patch
---

`blume migrate mintlify` now rewrites Mintlify accordions to Blume's shape. Mintlify wraps `<Accordion title="…">` items in an `<AccordionGroup>`, whereas Blume inverts that: `<Accordion>` is the container and each item is an `<AccordionItem title="…">`. The migrator previously left both tags untouched, so migrated pages that used accordions failed the MDX build outright — Blume ships no `<AccordionGroup>` component, so rendering threw `Expected component AccordionGroup to be defined` — and the nested `<Accordion title=…>` items lost their title and expand behavior. The group is now remapped to `<Accordion>` and every item to `<AccordionItem>` (preserving `title`, `icon`, and other props), so those pages build and render correctly.
