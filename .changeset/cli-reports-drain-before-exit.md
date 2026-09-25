---
"blume": patch
---

`blume translate`, `blume validate`, and `blume doctor` now let their whole report reach a piped stderr before exiting with a failure. Before, they exited immediately after writing, so a long list of findings could be cut off in CI logs and `| tee` output — the same fix `blume audit` and `blume eval` got.
