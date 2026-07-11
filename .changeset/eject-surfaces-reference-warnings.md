---
"blume": patch
---

`blume eject` discarded the Scalar API reference warnings that `blume dev` and `blume build` print — a spec file that wasn't found (so the ejected page points Scalar at a URL that 404s) or a reference route colliding with a content page went unreported. Eject now surfaces those warnings the same way the generated runtime does.
