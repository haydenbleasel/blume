---
"blume": patch
---

Fix `blume check` failing on generated files under a strict tsconfig: island and example wrappers now mirror the wrapped component's props onto `Astro.props` so required props type-check through the spread, and the OG endpoint's `customRoutes` array is explicitly typed so an empty list is no longer an implicit `any[]`.
