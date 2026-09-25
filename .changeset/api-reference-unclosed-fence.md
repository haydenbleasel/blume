---
"blume": patch
---

An OpenAPI, AsyncAPI, or GraphQL description that ends inside an unclosed code fence no longer swallows the reference UI rendered after it. The fence used to run to the end of the page, so an operation page lost its parameters, responses, and playground, and an overview page lost its operation lists. Blume now closes the fence where the description ends.
