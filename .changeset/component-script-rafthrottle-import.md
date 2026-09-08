---
"blume": patch
---

Fix a `ReferenceError: rafThrottle is not defined` thrown on every docs page: the `<Component>` script block used `rafThrottle` without importing it, so the resize handler that reclamps measured preview-frame heights never registered.
