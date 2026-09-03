---
"blume": patch
---

Keep a Scalar-rendered API reference on the page's theme. Scalar decided light or dark on its own — from its own localStorage key or the OS setting — and never read Blume's `data-theme`, so a reader whose stored preference disagreed with what their browser reports to `prefers-color-scheme` (Brave with its own dark color scheme over a light OS, for one) got a light navbar over a dark reference, with two toggles that didn't agree. The reference layout now pins Scalar's color mode to the current theme before it mounts, which also hides Scalar's own switch, and mirrors later flips of Blume's toggle onto the embed. A `scalar.forceDarkModeState` or `scalar.darkMode` set through the escape hatch is left to Scalar, as before.
