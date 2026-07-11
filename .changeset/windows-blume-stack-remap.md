---
"blume": patch
---

Internal-error stack traces now relativize `.blume/` runtime frames on Windows too. The remap previously matched only POSIX absolute paths, so drive-letter frames like `C:\...\.blume\...` printed the full machine path instead of the project-relative `.blume\...` form tagged `(generated)`.
