---
"blume": patch
---

A `trace` operation's Try it panel now says that browsers can't send `TRACE` requests when you press Send, instead of blaming CORS or an unreachable API: `fetch` refuses the method before anything goes out. Its JavaScript sample, which is built on `fetch`, is now a note saying so rather than code that could only throw. The cURL and Python samples still send it.
