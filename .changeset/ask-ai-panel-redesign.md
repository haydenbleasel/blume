---
"blume": patch
---

Redesign the Ask AI assistant. The trigger is now a ghost chat-icon button on the far right of the header, and it opens a full-height docked side panel (in the style of `vercel.com/docs`): on desktop the docs content shrinks to make room and the table of contents hides while the panel is open; on smaller screens it's a full-width overlay. The panel renders answers as Markdown, streams responses, supports a `⌘I` / `Ctrl+I` toggle, and has copy/clear/close controls. The input is a single flush textarea.

Add `ai.ask.suggestions` — empty-state prompts shown before the first question, each a clickable `{ label, icon? }` chip.

Improve grounding quality:

- Retrieval now injects the section of a page most relevant to the question instead of always slicing the page head, so a long page's below-the-fold content is reachable.
- Ask AI grounds on Markdown (code blocks preserved) rather than search-flattened plain text, so the model can answer from fenced examples the docs actually contain.
- The model cites sources as Markdown links, rendered as small source pills that navigate to the cited page.

Remove the "Ask AI about this page" entry from the page actions menu.
