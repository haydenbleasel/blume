---
"blume": patch
---

Support trailing `{#custom-id}` heading markers as an equivalent of `[#custom-id]` — verbatim in `.md`, and as the escape `\{#custom-id\}` in `.mdx`, where a bare `{…}` is a JSX expression. `blume check` now reports a bare `{#id}` in an `.mdx` page (or in a partial it includes) as `BLUME_MDX_CURLY_ANCHOR` instead of leaving it to fail at compile time, and `blume translate` is told to preserve the marker. Fragment-link validation also recognizes ids on raw HTML elements (`<a id="…">`, including tags wrapped over several lines) as anchor targets, ignoring ids inside code, inline code, HTML comments, `<Prompt>` blocks, and component props.
