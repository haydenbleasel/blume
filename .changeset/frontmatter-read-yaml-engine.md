---
"blume": patch
---

Apply the js-yaml 4-safe YAML engine to `matter.read` as well. The front-matter wrapper previously exposed gray-matter's own `read` helper unwrapped, so reading a file through it would parse with the removed `safeLoad` default and crash with "Function yaml.safeLoad is removed in js-yaml 4" — the exact failure the wrapper exists to prevent for `matter()` and `matter.stringify()`.
