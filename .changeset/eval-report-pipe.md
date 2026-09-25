---
"blume": patch
---

A failing `blume eval` now delivers its whole report through a pipe before exiting non-zero. It used to exit as soon as it wrote the summary, so a long `--verbose` report was cut off partway in CI logs.
