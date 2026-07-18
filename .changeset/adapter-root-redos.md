---
"blume": patch
---

Strip trailing slashes from the deploy adapter root with a linear scan instead of a `/\/+$/` regex. The old pattern could backtrack polynomially on a root path containing long runs of `/` (CodeQL `js/polynomial-redos`); the new trim is O(n) and yields the same single-trailing-slash directory URL.
