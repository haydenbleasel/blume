---
"blume": patch
---

Show the error notice, not the raw error body, when an Ask AI request fails. The in-page island streamed `response.body` without checking `response.ok`, so a 4xx/5xx (e.g. a rate-limit or server error) had its error text decoded and rendered as the assistant's answer. Non-OK responses now surface the friendly error message instead.
