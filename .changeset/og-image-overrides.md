---
"blume": patch
---

Support custom `og:image` overrides on custom pages. `PageLayout`'s `ogImage`
prop now resolves a root-relative path (a file in `public/`) against
`deployment.site` to the absolute URL crawlers require; absolute URLs pass
through unchanged. This lets a marketing home or landing page set a bespoke
social image instead of the generated Open Graph card.
