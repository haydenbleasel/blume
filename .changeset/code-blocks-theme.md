---
"blume": patch
---

Apply the `markdown.codeBlocks.theme` config to code rendering. The `theme.{light,dark}` Shiki theme names (defaults `github-light`/`github-dark`) were validated but never read; they now drive every highlighted surface — fenced code blocks, inline `` `code`{:lang} `` snippets, the `<CodeBlock>` and `<Component>` source panes, OpenAPI request/response samples, and `<Diff>` — so e.g. `markdown: { codeBlocks: { theme: { dark: "vesper" } } }` recolors dark-mode code while an unset side keeps its github default. Any bundled Shiki theme name works.
