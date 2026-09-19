---
"blume": major
---

Replace the top-level `openapi`, `asyncapi`, and `graphql` config blocks with a single `reference` list of adapters imported from `blume/reference`. Where the config used to enable each kind with its own keyed block, it now lists what to render, in order:

```ts
import { asyncapi, graphql, openapi, scalar } from "blume/reference";

export default defineConfig({
  reference: [
    openapi({ spec: "./openapi.yaml" }),
    openapi({
      spec: "./legacy.yaml",
      route: "/legacy",
      renderer: scalar({ theme: "purple" }),
    }),
    asyncapi({ spec: "./asyncapi.yaml" }),
    graphql({
      spec: "./schema.graphql",
      endpoint: "https://api.example.com/graphql",
    }),
  ],
});
```

Each adapter returns a plain, serializable descriptor (`kind`, `options`, `runtimeDeps`, `requiredSecrets`) that the config schema validates and the generated site reads as a literal; the reference resolver, the generated `package.json`, `blume doctor`, and the secrets check iterate the list instead of switching on a kind. The same kind can appear more than once, each entry with its own route, renderer, and display options. `spec` stays the shorthand for a single source and resolves into `sources` at parse, so an adapter always has at least one source. The renderer is `scalar({ theme, …options })`, accepted on `openapi()` and `asyncapi()` only; every other `scalar()` key is forwarded verbatim to the embedded Scalar reference, and the renderer declares `@scalar/astro` as its runtime dependency. The old keys are gone: a config that still uses them fails validation with a hint pointing at the list form.

To migrate, move each block onto its factory and drop `enabled`:

- `openapi: { enabled: true, spec, sources, route, codeSamples, expandSchemas, playground }` → `openapi({ spec, sources, route, codeSamples, expandSchemas, playground })`.
- `asyncapi: { enabled: true, … }` → `asyncapi({ … })`, with the same options.
- `graphql: { enabled: true, spec, endpoint, sources, route, codeSamples, playground }` → `graphql({ spec, endpoint, sources, route, codeSamples, playground })`.
- `renderer: "scalar"` with `theme: "purple"` and `scalar: { localization }` → `renderer: scalar({ theme: "purple", localization })`.
- `enabled: false` → leave the adapter out of the list.
