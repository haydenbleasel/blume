---
"blume": patch
---

Emit the request body in the playground's JavaScript and Python code samples as the raw editor text, never re-read as a JavaScript object literal or Python dict. The generated sample now sends byte-for-byte what the live request sends: a `__proto__` key stays a key, an id past 2^53 keeps its digits, and `1e400` is not re-serialized as `Infinity`.
