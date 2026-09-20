---
"blume": major
---

Replace the `search.provider` string and its sibling credential blocks with search adapters. `search` now takes an adapter imported from `blume/search` — `orama()` (still the default, so zero-config sites are unchanged), `flexsearch()`, `pagefind()`, `algolia({ appId, apiKey, indexName })`, `oramaCloud({ endpoint, apiKey, indexId })`, `typesense({ host, collection, apiKey })`, `mixedbread({ storeId })` — or `false` to disable search. Pass the adapter directly, or as `search: { provider, popular, indexing }` to keep curated links and indexing options beside it.

Each adapter is a plain, JSON-serializable descriptor that owns its options, runtime dependency, integration mode, and required secrets, so the generated project, `blume doctor`, the secrets check, and an ejected site all read the descriptor instead of switching on a provider name. The hosted adapters' options are kept verbatim and inlined as a literal into the generated client, so an option Blume doesn't name still reaches the SDK; they must be JSON values, and a function, `undefined`, or a bigint fails config validation with a path. The keyless adapters (`orama()`, `flexsearch()`, `pagefind()`) take no options and reject unknown keys, since their clients never read them.

Migration: `search: { provider: "algolia", algolia: { appId, indexName, searchApiKey } }` becomes `search: algolia({ appId, indexName, apiKey: searchApiKey })`; the Orama Cloud, Typesense, and Mixedbread blocks map the same way (the search-only key is `apiKey` everywhere), `provider: "pagefind"` becomes `pagefind()`, and `provider: "none"` becomes `search: false`. Admin keys stay in `ALGOLIA_ADMIN_API_KEY`, `ORAMA_PRIVATE_API_KEY`, `TYPESENSE_ADMIN_API_KEY`, and `MIXEDBREAD_API_KEY`.
