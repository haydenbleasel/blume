---
"blume": patch
---

Add a `clics()` analytics adapter. It renders the Clics tracker tag with `projectId` as `data-project-id`, and the tracker counts pageviews (client-side navigations included) and outbound-link clicks. `allowLocalhost` and `disableOutboundLinks` set the tracker's matching flags. Blume's custom events don't reach Clics, whose tracker has no global event API.
