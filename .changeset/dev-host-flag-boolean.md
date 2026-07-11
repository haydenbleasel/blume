---
"blume": patch
---

A bare `--host` on `blume dev` and `blume preview` now binds all network interfaces, matching Astro's own flag semantics. Previously the valueless flag parsed as an empty string, which Vite treated as a literal hostname and printed malformed URLs like `http://:4321/`. An explicit `--host 10.0.0.1` still binds that address.
