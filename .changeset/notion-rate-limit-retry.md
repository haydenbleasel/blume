---
"blume": patch
---

Retry Notion API calls on rate limits instead of aborting the import. A large workspace fans out many concurrent block-children requests, so a single `429` would reject the batch and fail the whole Notion source. Requests now retry with `Retry-After`-aware exponential backoff before giving up.
