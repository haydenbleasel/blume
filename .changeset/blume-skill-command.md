---
"blume": patch
---

Add `blume skill`, which writes your docs site's agent skill with a coding agent. `blume skill --claude` (or `--codex`) opens the agent on the new `blume-write-skill` skill. The agent writes a `SKILL.md` grounded in the docs that teaches an agent to use the product: setup, core concepts, common tasks, and gotchas, each linked to its page. The file goes under `agents.skills`, named after the site so it replaces the generated skill at `/skill.md`. Run it again to refresh the skill after big docs changes.
