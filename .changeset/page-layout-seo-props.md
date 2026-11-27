---
"blume": minor
---

`PageLayout` takes four new props for custom pages. `pageType` (`"blog"` or `"changelog"`) makes the page an article, with `og:type: article`, `article:published_time` and `article:modified_time`, and a `BlogPosting` or `TechArticle` JSON-LD node. `published` sets its publication date. `structuredDataType` sets the JSON-LD page node's `@type`, such as `"WebPage"` for a landing page or `"CollectionPage"` for an index. A named `head` slot puts the page's own tags in `<head>`, like a feed's `alternate` link.
