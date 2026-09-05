---
"blume": patch
---

Add a per-source `seoDescriptionSuffix` option to the `openapi`, `asyncapi`, and `graphql` reference blocks. Generated operation pages derive their meta description from the operation's own prose followed by a generated English sentence ("Reference for the `GET /pets` endpoint in the Petstore API."), which kept every page distinct but left non-English sites with half-translated metadata that no amount of authored prose could fix. Set `seoDescriptionSuffix: false` on a source to describe its pages with the spec's `description` (or `summary`) alone; an operation with neither falls back to its language-neutral title (`GET /pets`, the channel and action, or the GraphQL field or type name), so no page ships an empty description. The default is unchanged.
