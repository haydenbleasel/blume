---
"blume": patch
---

`blume build --isolated` now honours `--analyze`, `--budget-js`, and `--budget-css`, measuring the isolated build's own output. Previously the isolated path skipped the bundle report and budget gate entirely, so a CI run like `blume build --isolated --budget-js 100` exited 0 without measuring anything — a silent false pass.
