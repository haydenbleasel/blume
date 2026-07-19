---
"blume": patch
---

Evaluate `{frontmatter.*}` prop expressions when downleveling components for agent-facing output. Serializers — built-in and `ai.markdownComponents` — now receive the same values the rendered page shows instead of empty props, and the page's front-matter is exposed on the serializer context.
