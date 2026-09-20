---
"blume": patch
---

Report Ask AI usage through the configured analytics providers, the way page feedback already is: `ask` when a question is sent, `ask_answer` when the answer finishes (with latency and length), and `ask_error` when the request fails (with the HTTP status), each carrying the question and the page it was asked from. Custom chat UIs built on `useAskAI` report the same events.
