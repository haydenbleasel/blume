# Operating Procedure

Use this procedure after running `scripts/docs_harness.py` and reading the
evidence report.

## Mode selection

- **Maintenance mode**: use when docs already exist and the task mentions recent
  PRs, merged work, releases, drift, weekly automation, or "keep docs updated."
- **Init mode**: use when the repo has no useful docs root, only a README, or the
  user asks to create docs from a codebase.
- **Audit-only mode**: use when the user asks for findings, gaps, review, or an
  evidence report without edits.

## Maintenance mode

1. Identify the docs root, target branch, lookback window, and branch naming
   policy from repo instructions or the user prompt.
2. Run the scanner with `--mode maintenance` and the configured
   `--lookback-days`.
3. Compare recent merged work, current public surfaces, changelogs, tests, and
   examples against Markdown/MDX docs.
4. Ignore feature-flagged, private, experimental, deprecated-but-hidden, or
   unreleased behavior unless the docs explicitly target that audience.
5. Edit only pages with factual drift. Avoid subjective rewrites.
6. Update navigation/meta files when pages are added, renamed, moved, or removed.
7. Validate the touched docs with the repo's docs build, link/frontmatter checks,
   and focused examples or commands.
8. Open or update one focused `blume/*` PR only when docs changed.

## Init mode

1. Run the scanner with `--mode init`.
2. Identify the product type from public surfaces:
   - Library or SDK: exported package entrypoints, examples, types, and tests.
   - CLI: package bins, command files, CLI help, config, and env vars.
   - Web app: routes, API handlers, components, auth flows, and config.
   - Framework or plugin: configuration schema, extension points, generated
     outputs, and examples.
3. Draft an information architecture before writing pages:
   - Start with `index`, `quickstart`, and the strongest reference page.
   - Add concept pages only for ideas required to use the product correctly.
   - Add migration/change docs only when the repo contains release or migration
     evidence.
4. Copy the closest templates from `assets/templates/` into the docs root, then
   replace every placeholder with evidence from code, tests, or examples.
5. Include "unknown" or "needs product decision" in the evidence report rather
   than fabricating positioning, roadmap, pricing, or support promises.
6. Validate that the generated docs build and navigation works.

## Audit-only mode

1. Run the scanner with `--mode audit`.
2. Manually inspect the highest-risk findings: undocumented CLI/config/env
   surfaces, missing quickstart path, broken local links, and feature-flag
   signals.
3. Produce the evidence report and recommended edits. Do not modify files unless
   the user confirms.

## Validation gates

Run the strongest reasonable local checks for the repo. Prefer this order:

1. Docs build or static export command.
2. Docs lint, Markdown lint, typecheck, or frontmatter validation.
3. Link checker when available.
4. Focused tests for generated snippets, examples, config schemas, or CLI help.
5. Full repo QA when the docs change shared generated artifacts or public
   examples used by tests.

Report every command and result. If a check fails for an unrelated existing
issue, include the failing command, exact failure, and why it is unrelated.

## PR rules

- Use an existing open docs-maintenance PR if it targets the same goal and branch
  prefix.
- Otherwise create a branch named `blume/docs-refresh-YYYY-MM-DD` for
  maintenance or `blume/docs-init-YYYY-MM-DD` for init.
- Keep the diff focused on docs, templates, scanner output needed by the PR, and
  navigation changes.
- Do not commit `.homelander/` reports unless the repo explicitly wants audit
  artifacts in source control.
- PR title examples:
  - `blume: refresh docs for 2026-06-29`
  - `blume: scaffold docs from codebase`
- PR body must include:
  - Evidence report summary.
  - Public surfaces inspected.
  - Docs changed or generated.
  - Skipped flagged/unreleased/private work.
  - Validation commands and results.
  - Remaining questions or follow-up.
