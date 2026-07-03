---
"blume": patch
---

`blume migrate mintlify` now removes the source `docs.json`/`mint.json` after writing `blume.config.ts`. Leaving the Mintlify config on disk kept the project a bridge-mode candidate: any later run without a loadable `blume.config.*` would silently fall back to serving the un-migrated Mintlify project. The foreign config is only deleted after the Blume config is safely written, so a mid-migration failure never leaves the project with neither.
