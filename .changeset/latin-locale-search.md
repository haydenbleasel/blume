---
"blume": patch
---

Search now keeps words whole whatever Latin letters they hold. Orama's default tokenizer split words at any letter beyond ASCII and a few accented vowels, so Swedish "när" was indexed as "n" and "r" and matched unrelated pages, and German "Prüfung" as "pr" and "fung". Blume now keeps every Latin letter, folding accents the way Orama already folded "café" and spelling ø, ł and ß as o, l and ss, in the default Orama search dialog, the MCP server's `search_docs`, and the assistant. A soft hyphen (`&shy;`) no longer splits the word it sits in, and a result found by folding is highlighted and excerpted at the accented word. ASCII text is tokenized exactly as before.
