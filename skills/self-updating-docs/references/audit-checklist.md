# Audit Checklist

Use this checklist to decide whether a scheduled docs update should make changes.

## Sources to Check

- Repo instructions: `AGENTS.md`, `CLAUDE.md`, contribution docs, release docs, PR templates, and package scripts.
- Blume docs config: `blume.config.ts`, `content.root`, navigation/meta files, deployment/site settings, AI/MCP settings, search settings, OpenAPI/AsyncAPI sources, theme config, and export settings.
- Public APIs: exported package entrypoints, generated type declarations, config schemas, component props, CLI commands, route handlers, environment variables, and plugin/registry items.
- User workflows: quickstarts, examples, migration guides, deployment guides, screenshots, sample projects, and README snippets.
- Recent merge signals: PRs merged within the configured lookback window, changelogs, release notes, changesets, tags, and package version bumps. Default to 7 days when the automation does not specify a window.
- Docs Markdown: `apps/docs` when present, otherwise `docs`, the Blume project root, or the configured `content.root`.
- External dependencies: official provider docs and release notes for linked integrations, only when the docs mention them or the dependency changed.
- Generated docs surfaces: `llms.txt`, raw Markdown URLs, MCP tools, OpenAPI pages, search indexes, sitemap, robots, RSS, and generated OG behavior when relevant.

## Change Criteria

Make a docs edit when at least one condition is true:

- A command, config option, environment variable, route, CLI flag, component prop, or default value changed.
- A documented workflow no longer works or misses a required step.
- A page promises a feature, provider, adapter, or integration that the code no longer supports.
- A new user-facing capability exists but is absent from the appropriate docs page.
- A link points at moved, removed, or outdated primary documentation.
- A changelog or release page needs an entry for shipped user-facing behavior.

Skip edits when the only available change is subjective polish, wording preference, duplicate information, speculative future work, or behavior still hidden behind a feature flag.

## Blume Editing Guidance

- Keep frontmatter short and factual. Use `title` and `description` consistently with nearby pages.
- Preserve existing page order and `defineMeta` style. Update `pages` arrays when adding or renaming pages.
- Use Blume content components already present in the docs instead of inventing new markup patterns.
- Prefer fenced code blocks with filenames and line numbers when nearby docs use them.
- Keep links root-relative for internal docs pages.
- Do not edit generated `.blume/`, `dist/`, or plan/spec files unless the repo explicitly requests it.

## PR Notes

Include these sections in the PR body or automation summary:

- Sources checked
- Docs changed
- Verification run
- Skipped checks, with reasons
- Remaining risk or follow-up
