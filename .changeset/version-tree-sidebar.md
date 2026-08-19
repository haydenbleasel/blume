---
"blume": patch
---

Fix the sidebar rendering empty on archived version pages when header tabs are configured. A version tree's navigation root is versionized while tab paths stay in current-docs space, so the root tab was misread as a section tab that owns no group in the snapshot; it is now recognized as the root tab and the archived sidebar renders its full tree.
