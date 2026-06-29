---
name: homelander
description: Agent-native docs harness for creating or maintaining documentation directly from a codebase. Use when asked to run DeepSec-style docs analysis, generate first-pass docs from source code, compare merged PRs or changed public surfaces against Markdown/MDX docs, ignore feature-flagged or unreleased behavior, validate docs changes, produce evidence reports, or open focused blume/* documentation PRs from Codex, Cursor, Claude, or scheduled automations.
---

# Homelander

## Overview

Use Homelander as an agent-invoked docs harness. The skill is the UX and policy
layer; bundled scripts, templates, validators, and references are the reliable
substrate. The user or automation invokes the skill, then the agent runs the
tools and follows the procedure.

Homelander has three modes:

- **Maintenance mode**: compare recent merged work and current public surfaces
  against existing docs, update stale Markdown/MDX, validate, and open or update
  a focused `blume/*` PR.
- **Init mode**: inspect a repo with little or no docs and generate a first
  useful documentation set from the codebase.
- **Audit-only mode**: inspect and report evidence without editing files.

## Required First Steps

1. Read the nearest repo instructions: `AGENTS.md`, `CLAUDE.md`, Cursor rules,
   contribution docs, PR template, and package scripts.
2. Inspect the current branch and worktree. Do not overwrite unrelated user
   changes.
3. Choose a mode:
   - No docs root or empty docs root: use init mode.
   - Existing docs plus recent merged work or a schedule: use maintenance mode.
   - User asks for findings only: use audit-only mode.
4. Run the evidence scanner from the repo root. Replace `skills/homelander` with
   the installed skill path if the skill lives elsewhere:

```bash
python3 skills/homelander/scripts/docs_harness.py \
  --repo . \
  --mode maintenance \
  --lookback-days 7 \
  --output .homelander/evidence.md \
  --json-output .homelander/evidence.json
```

Use `--mode init` for new docs and `--mode audit` for read-only inspection. Add
`--docs-root path/to/docs` when the repo uses a nonstandard docs location.

## Workflow

1. **Collect evidence**
   - Run `scripts/docs_harness.py`.
   - Read `.homelander/evidence.md`.
   - Use the JSON output for exact lists when planning pages or validating links.

2. **Plan documentation work**
   - Read `references/operating-procedure.md` for mode-specific steps and PR
     gates.
   - Read `references/source-patterns.md` when scanner output needs manual
     follow-up across routes, APIs, SDK exports, CLI commands, config, env vars,
     schemas, or components.
   - Build a short plan from evidence, not from memory.

3. **Update or create docs**
   - Edit the smallest set of docs needed in maintenance mode.
   - In init mode, scaffold a coherent first docs set. Prefer copying and
     adapting files from `assets/templates/`.
   - Preserve existing docs voice, frontmatter, navigation, and component style.
   - Never document feature-flagged, unreleased, private, or speculative behavior
     as generally available.

4. **Validate**
   - Run the repo's documented docs build and the strongest reasonable focused
     checks.
   - Validate links, frontmatter, navigation entries, generated snippets,
     examples, imports, and commands affected by the change.
   - Fix failures caused by your docs changes. Report unrelated failures
     separately.

5. **Report and open PR**
   - Always produce an evidence report in the final summary or PR body.
   - If no docs changes are needed, do not open a PR. Report inspected surfaces
     and the no-op result.
   - If docs changed, create or update a focused branch named
     `blume/docs-refresh-YYYY-MM-DD`, `blume/docs-init-YYYY-MM-DD`, or another
     repo-approved `blume/*` name.
   - Open or update a PR to the repo default branch with evidence, files changed,
     validation results, skipped items, and remaining questions.

## Evidence Rules

- Treat docs as an extension of the codebase. Public code surfaces are the source
  of truth, and docs are the user-facing projection.
- Prefer deterministic scanner output over broad prompt-only reasoning.
- Cross-check scanner findings manually before editing docs.
- Use primary sources inside the repo first: code, schemas, CLI help, generated
  types, tests, examples, changelogs, and release notes.
- Skip feature-flagged or unreleased behavior unless the repo explicitly
  documents that audience.
- Surface uncertainty as a remaining question instead of inventing product
  intent.

## Resources

- `scripts/docs_harness.py`: deterministic first-pass scanner for public
  surfaces, docs inventory, feature-flag signals, link/frontmatter issues,
  recent git changes, and evidence reports.
- `references/operating-procedure.md`: detailed init, maintenance, validation,
  and PR workflow.
- `references/source-patterns.md`: scanner coverage and manual inspection
  patterns for public surfaces and unreleased work.
- `references/automation-examples.md`: Codex, Cursor, Claude, and weekly
  scheduled automation prompts.
- `assets/templates/*.mdx`: starter page templates for generated docs.
