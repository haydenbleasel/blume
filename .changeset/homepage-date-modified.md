---
"blume": patch
---

The homepage now emits a `WebPage` JSON-LD node with its description, language, and dates, including each locale's homepage, the root of a `basePath`, and sites without `deployment.site`. `PageLayout` takes a `lastModified` prop to date a custom homepage, and the "Last updated" date on every page is wrapped in a `<time>` element, so search engines no longer pick up an unrelated date from the page.
