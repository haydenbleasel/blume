---
"blume": patch
---

Adopt Astro's client router (`<ClientRouter />`) for page navigation. Same-origin link clicks now swap the new page into the live document instead of tearing it down for a full load, so navigation is flicker-free in every browser — including Firefox, which has no cross-document paint holding and briefly flashed a blank frame between pages. Navigations animate with native view transitions where supported and Astro's fade fallback elsewhere, both honoring `prefers-reduced-motion`; the sidebar keeps its scroll position across pages; search results navigate through the router too; and PostHog analytics captures a pageview per client-side navigation. The Scalar API reference intentionally keeps full-page loads (it is a SPA that mounts once per document), and the cross-document `@view-transition` rule from the previous release is gone — the router supersedes it.
