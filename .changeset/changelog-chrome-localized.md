---
"blume": patch
---

The generated changelog index's heading, page title, and meta description now come from the translatable `changelog.title` and `changelog.description` UI strings (translated in every built-in pack), joining the reveal button the template already localized. Previously the page rendered a hardcoded English "Changelog" heading, an English " changelog" title suffix, and an English description even on non-English default locales.
