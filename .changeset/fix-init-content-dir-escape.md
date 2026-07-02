---
"blume": patch
---

Reject a `--content-dir` on `blume init` that escapes the project. The value is
joined into every scaffolded file path, so `--content-dir ../../foo` would write
seed content outside the target directory. An absolute or `../`-escaping content
dir now errors out.
