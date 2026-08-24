---
"blume": minor
---

Native GraphQL API reference. Point the new top-level `graphql` config block at a schema — SDL text or an introspection JSON result, local or remote — and Blume generates one real page per root field (grouped as Queries, Mutations, and Subscriptions) plus one page per named type (Objects, Input Objects, Enums, Interfaces, Unions, and custom Scalars), all in the sidebar, search, llms.txt, and OG images like any hand-written doc. Operation pages show arguments with defaults and deprecations, a generated example operation with typed variables and a matching example response, live code samples, and the same Try it playground the OpenAPI reference ships — a plain JSON POST of `{ query, variables }` against the configured `endpoint`, with `playground.proxy` support for CORS-restricted APIs. Type pages cross-link every type reference and list where each type is used.
