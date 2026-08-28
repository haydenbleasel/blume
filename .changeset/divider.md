---
"blume": patch
---

Drop the page-actions divider when the rail has no table of contents. The actions block carries its own top border as a separator under the contents, but the contents only render when a page has a heading within `toc.minHeadingLevel`–`toc.maxHeadingLevel` — so on a page without one the block drew a rule across the top of an empty column. The rail now decides once whether an outline renders and passes that to the block (`divider` prop, default on), so the two cannot disagree.
