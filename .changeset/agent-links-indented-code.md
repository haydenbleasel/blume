---
"blume": patch
---

In a `.md` page, a link or image inside an indented code block is now left as written on the agent surfaces (the `.md` mirrors, `llms-full.txt`, MCP `get_page`, and the assistant's excerpts), and `blume validate` no longer checks it, as with one in a fenced block. A link or image in a comment is left as written on the agent surfaces too, and a page from a content source now renders an image or file link in its indented code as written, as does any page for one in an included partial's indented code or comments. Before, they were rewritten to routes or served file URLs, and `blume validate` reported a link in indented code as broken when it didn't resolve.
