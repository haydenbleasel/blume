---
"blume": patch
---

Add a `oneDollarStats()` analytics adapter. It renders the OneDollarStats tracker tag, needs no key, and forwards every option as a `data-` attribute (`hostname`, `devmode`, …). Page feedback events reach `window.stonks.event` with their property values as strings.
