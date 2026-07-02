---
"blume": patch
---

Reject a non-numeric `--budget-js` / `--budget-css` on `blume build` instead of silently disabling the performance gate. `Number("250kb")` is `NaN` and `total > NaN` is always false, so a typo'd budget made the check pass no matter the bundle size. The flags are now validated up front and error out like `--output` and `--adapter`.
