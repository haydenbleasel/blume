---
"blume": patch
---

The assistant cites pages as links more reliably on smaller models. Each documentation excerpt it reads, and each `search_docs` and `read_page` result, is now headed by the Markdown link to cite (`## [Page Title](/route)`), and the model is asked to copy that link. A page whose route has a space or a parenthesis is cited with those characters percent-encoded (`%20`, `%28`, `%29`), so its link works too. Before, the heading was `## Page Title (/route)`, and a model that copied it wrote `[Page Title (/route)]`, `[[Page Title (/route)]]`, or `[/route]`, which showed in the answer as raw text instead of a link.
