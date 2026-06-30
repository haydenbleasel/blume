---
"blume": patch
---

Fix the Fumadocs `meta.json` → sidebar migration for the common flat-files-plus-separators layout. The Extract operator (`...folder`) is no longer kept as a literal `"...folder"` page slug; it now keeps the folder's place in the ordering and renders as a normal group. `---Section---` separators, which were previously dropped with a warning, are rebuilt as route-transparent Blume group folders: a section's flat pages move into a `(Section)/` folder (with a `meta.ts` preserving their order), a section that is a single folder is left in place, and links are reported for manual navbar placement. Routes are unchanged and per-folder `meta.ts` keeps working, since the migration reshapes the filesystem rather than emitting a global `navigation.sidebar` override.
