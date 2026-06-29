# Automation Examples

Use these prompts when configuring Codex, Cursor, Claude, or another scheduled
agent runner. Adjust repository, docs root, lookback window, and branch policy to
match the repo.

## Codex

```text
$homelander Run maintenance mode for the last 7 days. Inspect merged PRs and current public surfaces, compare them to the docs Markdown/MDX content, ignore feature-flagged or unreleased behavior, update stale docs only when needed, run the repo docs validation, and open or update one focused blume/* PR to main. Always include an evidence report.
```

For a repo with no docs:

```text
$homelander Run init mode. Inspect the codebase, infer the public product surface, scaffold a first useful Blume docs set from templates, validate the docs build, and open a blume/docs-init-* PR with an evidence report and remaining questions.
```

## Cursor

```text
/homelander Run maintenance mode weekly. Use a 7 day lookback window, compare merged user-facing code changes to apps/docs Markdown/MDX, skip feature-flagged work, validate docs, and create a blume/* PR only if edits are required. Include inspected surfaces, skipped changes, validation results, and open questions.
```

## Claude

```text
/homelander Run audit-only mode first. Produce a Homelander evidence report for current docs drift: public surfaces, docs inventory, feature-flag signals, likely doc gaps, validation findings, and recommended edits. Do not change files unless I confirm.
```

For a scheduled Claude routine:

```text
/homelander Run maintenance mode every Monday. Review merged PRs from the last 7 days, compare public code surfaces to docs, ignore unreleased or feature-flagged behavior, apply factual docs fixes, run docs QA, and open or update a focused blume/* PR. If no docs changes are needed, report the no-op evidence and do not open a PR.
```

## Generic weekly run

```text
Use the homelander skill. Run maintenance mode with --lookback-days 7. Compare recent merged work, routes, APIs, SDK exports, CLI commands, env vars, config, schemas, and components against the docs inventory. Skip feature-flagged and unreleased behavior. Update docs only for factual drift, validate changes, and open or update one blume/* PR to main. Always produce an evidence report.
```
