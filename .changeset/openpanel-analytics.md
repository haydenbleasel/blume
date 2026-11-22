---
"blume": patch
---

Add an `openpanel()` analytics adapter. It renders OpenPanel's script tag install with `clientId` mapped and every other option forwarded to `window.op("init")`, turning on screen views, outgoing links, and `data-track` attributes by default. The tracker counts client-side navigations itself, and Blume's custom events reach OpenPanel through `window.op("track")`. Set `scriptUrl` to load the tracker from a proxy or self-hosted instance.
