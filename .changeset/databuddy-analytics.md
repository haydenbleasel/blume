---
"blume": patch
---

Add a `databuddy()` analytics adapter. It renders Databuddy's tracker tag with `clientId` as `data-client-id` and forwards any other option as a `data-` attribute, and page feedback events reach `window.databuddy.track`.
