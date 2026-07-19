---
"blume": patch
---

Fail `blume build` (exit 1) when any page fails frontmatter validation, instead of silently dropping the invalid pages and reporting a green build. Pass `--no-strict` to restore the old lenient behavior — the build then warns how many pages were dropped instead of printing an unqualified success.
