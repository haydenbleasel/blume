---
"blume": patch
---

Fix tab navigation on routes that own no sidebar group. A page under a tab whose source produced no sidebar sections — a standalone page like the generated `/changelog` timeline — now renders an empty sidebar instead of falling back to the full tree, which had leaked every other tab's sections (e.g. the OpenAPI operations) onto the page. Chrome-only pages rendered via `PageLayout` (a landing page with tabs but no sidebar) also gain a working mobile navigation drawer: the header's nav toggle now appears whenever there are tabs — not only when a sidebar is present — and opens a slide-in tabs drawer below `lg`.
