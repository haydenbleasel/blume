# Operating Procedure

Use this procedure after running `scripts/docs_harness.py` and reading the
evidence report.

## Mode selection

- **Init mode**: use when the repo has no useful docs, only a README, or a fresh
  Blume scaffold.
- **Maintenance mode**: use when docs already exist and the task mentions recent
  PRs, merged work, releases, drift, weekly automation, or keeping docs updated.
- **Audit-only mode**: use when the user asks for findings, gaps, review, or an
  evidence report without edits.
- **Eval mode**: use when the user asks to compare Homelander output against
  existing docs, OSS repos, official docs, or template-pack coverage.

## Init mode

1. If no docs project exists, run the repo-appropriate `blume init` flow before
   writing final docs.
2. Run the harness with `--mode init --packs auto`.
3. Review selected packs, skipped packs, and planned pages.
4. Add `--include-packs` or `--exclude-packs` only when repo evidence or user
   intent is clear.
5. Run `--write-stubs` after the plan is acceptable.
6. Replace every scaffold marker with evidence-backed MDX.
7. Re-run the harness and fix DeepSec-style review findings.
8. Validate the docs build and open a focused `blume/docs-init-*` PR.

## Maintenance mode

1. Identify docs root, target branch, lookback window, and branch naming policy.
2. Run the harness with `--mode maintenance`.
3. Compare recent merged work, current public surfaces, changelogs, tests, and
   examples against the existing docs portfolio.
4. Ignore feature-flagged, private, experimental, deprecated-but-hidden, or
   unreleased behavior unless the docs explicitly target that audience.
5. Edit only pages with factual drift. Avoid subjective rewrites.
6. Update navigation/meta files when pages are added, renamed, moved, or removed.
7. Re-run the review turn and validation.
8. Open or update one focused `blume/*` PR only when docs changed.

## Audit-only mode

1. Run the harness with `--mode audit`.
2. Inspect selected packs, skipped packs, gaps, and review findings.
3. Produce recommendations without modifying files unless the user confirms.

## Eval mode

1. Read `references/evaluation.md`.
2. Choose a small target set before running broad benchmarks.
3. Run `scripts/docs_eval.py` against each target.
4. Compare official-implied packs, blind generated packs, required pages, and
   official pages without generated analogues.
5. Use results to revise classifiers, obligations, and pack templates. Do not
   treat one repo's docs taxonomy as universal.
6. Keep `.homelander-evals/` artifacts uncommitted by default.

## Validation gates

Run the strongest reasonable local checks for the repo. Prefer this order:

1. Docs build or static export command.
2. Docs lint, Markdown lint, typecheck, or frontmatter validation.
3. Link checker when available.
4. Focused tests for generated snippets, examples, config schemas, or CLI help.
5. Full repo QA when docs change shared generated artifacts or public examples
   used by tests.

Report every command and result. If a check fails for an unrelated existing
issue, include the failing command, exact failure, and why it is unrelated.

## PR rules

- Use an existing open Homelander PR if it targets the same branch and goal.
- Otherwise create a branch named `blume/docs-init-YYYY-MM-DD` for init or
  `blume/docs-refresh-YYYY-MM-DD` for maintenance.
- Keep the diff focused on docs source files, skill resources, templates, and
  navigation changes.
- Do not commit `.homelander/` or `.homelander-evals/` reports unless the repo
  explicitly wants audit artifacts in source control.
- PR body must include selected packs, skipped packs, docs changed, skipped
  flagged/unreleased work, validation results, and remaining questions.
