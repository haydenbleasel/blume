---
"blume": patch
---

Default-ignore never-content directories during the content scan. The filesystem source now always skips `node_modules`, `.git`, `.blume`, `.vercel`, `dist`, `.next`, `.turbo`, and `.cache` — in addition to the user's `content.exclude`, and even when `exclude` is overridden. Previously a broadly-scoped `content.root` (`"."` or an app directory that also holds `node_modules`/build output — the common shape when migrating a docs app that lives at the repo or app root) would glob thousands of stray Markdown files out of dependencies and build artifacts. `content.root` still defaults to `docs/`, where this rarely bit.
