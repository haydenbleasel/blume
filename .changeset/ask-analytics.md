---
"blume": patch
---

Report Ask AI usage through the configured analytics providers, the way page feedback already is: `ask` when a question is sent, `ask_answer` when the answer finishes (with latency and length), and `ask_error` when the request fails, breaks mid-stream, or comes back empty (with the HTTP status, or `0` when no response exists). Events carry the page's served pathname and the question's length; the question text itself travels only on the `blume:track` DOM event, so a site decides where reader input goes. Custom chat UIs built on `useAskAI` report the same events, and a throwing analytics provider no longer starves the providers after it.
