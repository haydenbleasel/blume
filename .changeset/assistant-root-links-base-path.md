---
"blume": patch
---

The assistant's root page links (`[Setup](/guides/setup)`) now get the `basePath` and the page's locale prefix, as the rendered page gives them, so a link the assistant cites lands on the page on a site with a `basePath`, and on the reader's translation when there is one. A link that already carries the `deployment.base` is read as including it, and one to a locale's copy of a page that isn't translated yet names the page the assistant reads in its place. Before, the assistant read root page links as written, and under a `basePath` the links it cited led to a 404.
