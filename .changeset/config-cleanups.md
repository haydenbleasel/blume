---
"blume": major
---

Simplify four corners of `blume.config.ts`. Each removed or renamed field now fails validation with a hint that names its replacement.

- `theme.layout` is removed. It only ever accepted `"sidebar"`, and nothing read it; delete the field.
- `markdown.codeBlocks` is merged into `markdown.code`. The Shiki theme pair moves from `markdown.codeBlocks.theme` to `markdown.code.theme`, beside `icons` and `wrap`.
- `lastModified` is a flat value: `false` (default), `"git"`, or `"frontmatter"`. `lastModified: true` becomes `"git"`, and `{ type: "git" }` / `{ type: "frontmatter" }` become the bare string.
- The `ai` namespace now holds only the model-facing features, `ai.ask` and `ai.openInChat`. The machine-readable surface moves to a new top-level `agents` key: `ai.api`, `ai.catalog`, `ai.llmsTxt`, `ai.markdownComponents`, `ai.mcp`, `ai.skills`, `ai.webBotAuth`, and `ai.webmcp` become `agents.api`, `agents.catalog`, `agents.llmsTxt`, `agents.markdownComponents`, `agents.mcp`, `agents.skills`, `agents.webBotAuth`, and `agents.webmcp`, and `seo.agentReadability` and `seo.contentSignals` become `agents.agentReadability` and `agents.contentSignals`.
