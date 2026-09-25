---
"blume": patch
---

`blume eval --threshold` rejects an empty value, which it used to read as `0`, so `--threshold "$EVAL_THRESHOLD"` with the variable unset switched the gate off. An absolute `--file` path is used as given instead of being nested under the project root, for runs and for `blume eval init`, whose "already exists" check missed it. `--timeout` on `blume eval` and `blume translate` refuses values above 2147483 seconds (about 24 days), which used to make every agent time out at once. Durations in their reports round before they split into minutes, so a run prints `2m 0s` rather than `1m 60s`, and `1m 0s` rather than `60.0s`.
