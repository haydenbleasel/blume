---
"blume": patch
---

Fix the sidebar rendering empty on archived version pages when header tabs are configured. A version tree's navigation root is versionized while tab paths stay in current-docs space, so the root tab was misread as a section tab that owns no group in the snapshot; it is now recognized as the root tab — via a single shared containment check used by sidebar scoping, tab-section pruning, and hoisting alike — and the archived sidebar renders its full tree. Header tabs also no longer claim `aria-current` on archived pages: they link back to the current docs, so none of them is the current page there.
