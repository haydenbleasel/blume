---
"blume": patch
---

Make `blume add`'s import rewriting statement-aware. It previously rewrote any
`from "./…"` substring, so a relative specifier appearing inside a string or JSX
text in a component could be mangled. Rewriting is now anchored to actual
`import`/`export` statements at the start of a line (multiline import bodies
still handled), leaving in-string and in-JSX text alone.
