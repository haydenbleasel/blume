---
"blume": patch
---

Resolve a section tab's link to its first page when the section has no index page, so the tab no longer 404s. A tab's `path` still scopes its sidebar section and matches the active tab, but the clickable target now falls back to the first page in the section (sidebar order) when nothing lives at the path itself — e.g. `/examples` with only `/examples/hello-world` links to that page instead of a missing `/examples`.
