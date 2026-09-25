---
"blume": patch
---

The `blume-migrate` skill's Mintlify codemod removes a dropped front matter key's list items even when they're written flush at column 0 (`keywords:` then `- one`), instead of leaving them behind as front matter that no longer parses. Its Fumadocs and Nextra guides now map locale file suffixes (`page.cn.mdx`, `index.en.mdx`) to `i18n.parser: "dot"` as-is rather than restructuring them into locale folders.
