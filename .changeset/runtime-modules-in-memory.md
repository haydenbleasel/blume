---
"blume": patch
---

Serve the runtime's data snapshots from memory instead of `.blume/src/generated/*.json`. The page data behind `blume:data`, the parsed API specs, the static search index, the raw-Markdown and content-asset maps, the MCP and Ask corpora, and the rendered RSS feeds are now published into an in-process registry by the generator and served to Vite as virtual modules, so a content edit in `blume dev` invalidates exactly the modules whose data changed and reloads the browser — no JSON write, no file-watcher round trip, and nothing half-written for the dev server to observe. `blume eject` is unchanged: the ejected project keeps the JSON files and aliases each module to them.
