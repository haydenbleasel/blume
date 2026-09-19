---
"blume": patch
---

Add `ai.ask.cors` to let listed origins call the generated Ask AI endpoint from another site. The route answers the browser's preflight and names a listed origin on every response, the streamed answer and error statuses alike, so a marketing page can embed an ask box without an external endpoint or an eject.
