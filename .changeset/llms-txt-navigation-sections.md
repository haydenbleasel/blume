---
"blume": minor
---

`llms.txt` now mirrors your navigation tree instead of emitting one flat list: sidebar folders and groups become Markdown headings (nested groups nest the heading level), each locale gets its own labeled section under i18n, and pages an explicit sidebar omits are appended under "Other". `ai.llmsTxt` also accepts an object form — `{ enabled, openapi }` — where `openapi: false` keeps generated API reference pages (OpenAPI/AsyncAPI) out of both `llms.txt` and `llms-full.txt`, for sites whose reference documents a placeholder or example spec. The bare boolean shorthand keeps working.
