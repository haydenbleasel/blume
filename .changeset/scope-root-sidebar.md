---
"blume": patch
---

Hide tab-owned groups from the root sidebar. On a route under no tab (or the
root `/` tab), the sidebar showed every top-level group — including the folders
that already have their own header tab — so a section like Adapters or API
appeared both as a tab and as a sidebar group. Those tab-owned groups are now
dropped from the un-scoped sidebar, leaving only the pages that don't belong to
a tab (and any group emptied by this is dropped too). If hiding them would blank
the sidebar, the full tree is shown, so a route is never left empty.
