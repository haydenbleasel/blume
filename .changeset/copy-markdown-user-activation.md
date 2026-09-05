---
"blume": patch
---

Copy as Markdown now works in Safari and Firefox. The action fetches the page's Markdown on click, and the clipboard write used to be issued only after that fetch resolved — outside the click's user activation, which those browsers require for a clipboard write — so it failed on every click. The write is now issued inside the click with the Markdown still loading (a promised `ClipboardItem`), and browsers without that API keep the previous fetch-then-write path.
