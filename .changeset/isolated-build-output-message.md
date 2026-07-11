---
"blume": patch
---

`blume build --isolated` now reports the build's actual output directory on success. A `server` output build with the Vercel adapter lands its deploy bundle at `.blume-verify/.vercel/output` (it is never surfaced to the project root), but the message previously pointed at `.blume-verify/dist`, which that build never populates.
