---
name: self-updating-docs
description: Keep Blume-powered documentation current from user-configured automations. Use when asked to monitor recently merged pull requests or other configured triggers, compare shipped user-facing changes against docs markdown content, ignore feature-flagged work that is not ready for docs, and open or update a blume/* pull request with verified documentation changes.
---

# Self-updating Docs

## Overview

Audit a Blume docs site for stale user-facing content from a user-configured automation, update only the pages that are factually out of date, verify the docs build, and open or update a `blume/*` pull request against `main`. Prefer no PR over a noisy PR when the scheduled run finds nothing actionable.

## Workflow

1. Establish the repo context.
   - Read the nearest `AGENTS.md`, `CLAUDE.md`, Cursor rules, or repo docs that define workflow and QA.
   - Identify the package manager, docs root, Blume config, content root, navigation/meta files, examples, and release/changelog conventions. Treat `apps/docs` as the default docs app when it exists; otherwise use `docs` or the configured Blume project/content root.
   - Honor the automation's configured trigger, lookback window, docs path, target branch, and PR policy. Use the defaults below only when the automation prompt does not specify them.
   - Inspect the current branch and worktree. Do not overwrite or revert unrelated user changes.

2. Reuse or create the maintenance branch.
   - Look for an existing open PR whose head starts with `blume/` and whose purpose is docs maintenance.
   - If one exists, check out that branch and update it.
   - Otherwise create a branch named `blume/docs-refresh-YYYY-MM-DD` from `main` unless repo policy names a different default branch.

3. Find user-facing drift.
   - Read `references/audit-checklist.md` for the source checklist and acceptance criteria.
   - Monitor pull requests merged into the default branch within the configured lookback window. Default to the last 7 days.
   - Compare those merged PRs against docs Markdown content, especially `apps/docs` when present.
   - Compare docs against code, config schemas, exported APIs, CLI help, examples, generated references, changelogs, and product behavior.
   - Treat feature-flagged work as not ready for public docs unless the flag is enabled for the documented audience or the repo explicitly documents unreleased/flagged behavior.
   - Check external primary sources only when docs link to them or the repo depends on them. Prefer official docs, release notes, or schemas over secondary summaries.
   - Keep notes on what was checked, what changed, and why an edit is needed.

4. Update the docs.
   - Edit the smallest set of pages needed to remove the drift.
   - Preserve the local voice, frontmatter, Blume components, line-numbered code fences, and `defineMeta` navigation patterns.
   - Add or remove navigation entries when pages are added, renamed, or deleted.
   - Avoid broad rewrites, marketing polish, and unrelated formatting.

5. Verify.
   - Run the strongest repo-appropriate docs validation path. At minimum, run the Blume docs build or the repo's documented docs QA.
   - Run lint, format, typecheck, tests, link checks, or preview verification when the touched area makes them relevant.
   - Fix validation failures caused by the docs changes. Report unrelated failures separately.

6. Commit and open or update the PR.
   - If no docs changes are needed, do not create a branch, commit, or PR. Report the sources checked and the no-op result.
   - Commit only the maintenance changes.
   - Push the `blume/*` branch and create or update a PR targeting `main` unless repo policy names a different default branch.
   - Use a title like `blume: refresh docs for YYYY-MM-DD`.
   - In the PR body, include checked sources, changed docs, QA commands/results, skipped checks, and residual risk.

## Review Rules

- Treat docs as user-facing product behavior. Do not invent features, timelines, pricing, APIs, or compatibility claims.
- Do not document feature-flagged behavior as generally available until the flag is enabled for the documented audience.
- Prefer exact source-of-truth wording for commands, options, route names, environment variables, and version numbers.
- Preserve generated or plan/spec folders unless the repo explicitly says to edit them.
- Avoid opening duplicate maintenance PRs for the same period.
- Keep automation comments concise and actionable; include links to the PR and verification output when the host supports status updates.

## Automation Prompt

Use this prompt for recurring jobs:

```text
Use the self-updating-docs skill. Monitor the PRs merged within the last 7 days. Compare them to apps/docs markdown contents and evaluate whether the docs need updates. Be aware that if something is behind a feature flag, it is not ready to be considered. If you modify the docs, verify the docs build and create a blume/* PR to main. If no docs changes are needed, report the PRs and docs areas checked and do not open a PR.
```

Run weekly for active products. Run daily during a launch, migration, or API churn period. Run monthly for stable docs.

## Resources

- `references/audit-checklist.md`: detailed source checklist, change criteria, and Blume-specific editing guidance. Read it before making docs changes.
