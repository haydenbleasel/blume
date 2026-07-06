---
"blume": patch
---

Stop the inline-code pill background from leaking into `not-prose` components. The hand-written `.prose :not(pre) > code` rule lacked the `not-prose` exclusion that Tailwind's generated prose rules carry, so components like the `<TypeTable>`, OpenAPI parameter/schema tables, and operation paths inherited a gray pill — which, as a grid cell, stretched to fill its column and painted edge-to-edge. Scope the rule to skip `not-prose` subtrees so those components render their own intended code styling.
