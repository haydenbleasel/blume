---
"blume": patch
---

Search now keeps words whole whatever Latin letters they hold. Orama's default tokenizer split words at any letter beyond ASCII and a few accented vowels, so Swedish "när" was indexed as "n" and "r" and matched unrelated pages, and German "Prüfung" as "pr" and "fung". Blume now keeps every Latin letter, folding accents the way Orama already folded "café", in the default Orama search dialog, the MCP server's `search_docs`, and the assistant. ASCII text is tokenized exactly as before.
