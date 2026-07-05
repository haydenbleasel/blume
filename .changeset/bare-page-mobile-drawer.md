---
"blume": patch
---

Fix the mobile menu on changelog (and other "bare") pages: the header hamburger only locked page scroll because bare layouts skipped the drawer entirely. The drawer now renders on mobile — with the section tabs kept visible when the page tree is empty — while desktop keeps the bare landing layout.
