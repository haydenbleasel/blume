---
"blume": minor
---

`blume init` is now interactive: in a terminal it asks where to create the project (also available as `blume init <dir>`), what your docs site is called, which template to use, and which content sources you need (filesystem, GitHub Releases, Notion, Sanity, remote MDX), then scaffolds a matching `blume.config.ts` — including a `content.sources` block with placeholder values, env-var hints, and the Notion/Sanity SDK dependencies when those sources are picked. Explicit flags pre-answer their prompts; `--yes`, CI, or piped stdio keep the previous non-interactive behavior with identical default output. The package manager for next-steps hints is auto-detected from `npm_config_user_agent`, and a non-default `--content-dir` now also emits `content.root` so the scaffolded project reads the right folder.
