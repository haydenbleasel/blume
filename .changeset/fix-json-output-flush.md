---
"blume": patch
---

Don't truncate `--json` diagnostics output in CI. `blume doctor --json` and `blume validate --json` wrote the JSON payload and then called `process.exit`, which doesn't flush a piped stdout — so a large payload could be cut off into invalid JSON that the consumer couldn't parse. The commands now drain stdout before exiting non-zero.
