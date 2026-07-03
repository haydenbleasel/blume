---
"blume": patch
---

The `mdx-remote` content source no longer sends `GITHUB_TOKEN` to non-GitHub hosts. Every fetch — including files enumerated from a custom `url` base pointing at an arbitrary server — attached `Authorization: Bearer $GITHUB_TOKEN`, leaking the repo credential to whatever host the source was configured against. The token is now only attached for `api.github.com` and `raw.githubusercontent.com`.
