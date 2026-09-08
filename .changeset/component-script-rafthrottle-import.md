---
"blume": patch
---

Fix a `ReferenceError: rafThrottle is not defined` thrown on pages that render `<Component>`: the script block used `rafThrottle` without importing it. Preview panes now cap at the viewport with CSS (`max-height: 100lvh`) instead of a resize listener, so a pane capped by a small window grows back when the window does, mobile toolbar collapse no longer resizes it, and the docs page asks already-loaded frames to re-report their height so a report sent before the listener registered isn't lost.
