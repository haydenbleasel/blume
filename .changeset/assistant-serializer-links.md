---
"blume": patch
---

In the assistant's excerpts, an API reference operation list (`<ApiTagOperations>`) and a page's `<Changelog />` release list now link pages by route, as the rest of the excerpts do, without the `deployment.base` or the site's URL. Before, under a `deployment.base`, those links carried the base, and the chat panel added it again, so a link the assistant cited from them led to a 404.
