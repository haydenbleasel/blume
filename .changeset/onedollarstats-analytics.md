---
"blume": patch
---

Add a `oneDollarStats()` analytics adapter. It renders the OneDollarStats tracker tag, needs no key, and forwards every option as a `data-` attribute (`hostname`, `devmode`, …). `hostname` must be a bare host name, and `"hash-routing": "false"` leaves the attribute off, since the tracker turns hash routing on whenever it's present. Blume's custom events (page feedback and Ask AI) reach `window.stonks.event` with their property values as strings.
