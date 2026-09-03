---
"blume": patch
---

Keep the dark theme on the page during client-side navigation. The client router replaces the root element's attributes with the incoming page's, which dropped `data-theme` until Blume re-applied it after the swap; in between, the router's scroll restoration computed the new page's styles with the light palette, so the sidebar, header tabs, language selector, search button, feedback buttons, previous/next links and page actions visibly animated from light to dark on every navigation. The theme is now stamped onto the incoming document before the swap, so it never drops.
