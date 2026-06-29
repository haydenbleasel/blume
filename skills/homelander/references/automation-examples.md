# Automation Examples

Use these prompts when configuring Codex, Cursor, Claude, or another scheduled
agent runner. Adjust repository, docs root, lookback window, and branch policy to
match the repo.

## Codex

```text
$homelander Run maintenance mode for the last 7 days. Classify the docs portfolio with composable packs, inspect merged PRs and current public surfaces, compare them to Markdown/MDX docs, ignore feature-flagged or unreleased behavior, update stale docs only when needed, run the DeepSec-style docs review turn, validate, and open or update one focused blume/* PR to main. Always include selected packs, skipped packs, and an evidence report.
```

For a repo with no docs:

```text
$homelander Run init mode. If no docs project exists, bootstrap with blume init first. Inspect the codebase, classify composable docs packs, scaffold MDX folders and meta.ts files with --write-stubs, author evidence-backed docs from the selected packs, run the DeepSec-style review turn, validate the docs build, and open a blume/docs-init-* PR with selected packs, skipped packs, review findings, and remaining questions.
```

## Cursor

```text
/homelander Run maintenance mode weekly. Use a 7 day lookback window, classify selected docs packs, compare merged user-facing code changes to apps/docs Markdown/MDX, skip feature-flagged work, run the DeepSec-style review turn, validate docs, and create a blume/* PR only if edits are required. Include inspected surfaces, selected packs, skipped packs, validation results, and open questions.
```

## Claude

```text
/homelander Run audit-only mode first. Produce a Homelander evidence report for current docs drift: selected packs, skipped packs, public surfaces, docs inventory, feature-flag signals, likely doc gaps, DeepSec-style review findings, and recommended edits. Do not change files unless I confirm.
```

For a scheduled Claude routine:

```text
/homelander Run maintenance mode every Monday. Review merged PRs from the last 7 days, classify composable docs packs, compare public code surfaces to docs, ignore unreleased or feature-flagged behavior, apply factual docs fixes, run the DeepSec-style review turn and docs QA, and open or update a focused blume/* PR. If no docs changes are needed, report the no-op evidence and do not open a PR.
```

## Generic weekly run

```text
Use the homelander skill. Run maintenance mode with --lookback-days 7 and --packs auto. Compare recent merged work, routes, APIs, model surfaces, SDK exports, CLI commands, env vars, config, schemas, integrations, and components against the docs portfolio. Skip feature-flagged and unreleased behavior. Update docs only for factual drift, run the DeepSec-style review turn, validate changes, and open or update one blume/* PR to main. Always produce an evidence report.
```
