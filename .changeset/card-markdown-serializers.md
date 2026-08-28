---
"blume": patch
---

Downlevel `<Card>` and `<CardGroup>` to Markdown on the agent-facing surfaces. Both are Blume's own components and neither had a serializer, so a section landing page — the shape `blume init` scaffolds and the Mintlify migrator emits — published raw JSX to `/<route>.md`, `llms-full.txt`, MCP `get_page` and the Ask AI corpus. A card becomes its title as a link over its body, with the `cta` last; a group becomes everything it holds, block by block. Serializers in `ai.markdownComponents` gain `childBlocks()` — every direct child of the element in order, each already downleveled — which is what `CardGroup` is built on.
