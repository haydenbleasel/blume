---
"blume": patch
---

Harden two scanners against pathological input: HTML comments stripped before anchor detection are replaced with a space so their neighbors can't splice into new markup, and `github.dir` plus source/meta route prefixes trim slashes linearly instead of with a regex that was quadratic on a run of `/`.
