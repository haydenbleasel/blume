---
"blume": minor
---

Rebuild OpenAPI support with a native, Blume-rendered API reference (default `renderer: "blume"`). Blume now parses each spec with Scalar's OpenAPI parser (upgrading Swagger 2.0 / OpenAPI 3.0 to 3.1) and lowers every operation into a real content page — so operations get their own route (`/reference/<tag>/<operation>`), a tag-grouped, tab-scoped sidebar with colour-coded method badges, and inclusion in site search, `llms.txt`, and Open Graph, just like any hand-written doc. Operation pages use a two-column layout: parameters and schema tables on the left, a Scalar-style Request/Response panel (language tabs + copy, status-tabbed response examples) on the right in place of the table of contents. New `openapi` options: `renderer` (`"blume"` | `"scalar"`), `codeSamples`, and `expandSchemas`. Set `renderer: "scalar"` to keep the embedded Scalar reference; AsyncAPI continues to render through Scalar.
