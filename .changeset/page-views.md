---
"blume": patch
---

Add `<View>` for pages written for several audiences, such as one per programming language. Each distinct `title` becomes an option in a picker above the page's content, and only the chosen view's blocks show. Prose outside any `<View>` shows in every view, and headings in hidden views drop out of the table of contents. The reader's pick is remembered across pages and written to the URL as `?view=`, a link to a heading opens its view, and the choice applies before the page paints. The agent-facing Markdown includes every view under its name.
