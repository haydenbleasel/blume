# DeepSec-Style Review Turn

Run this after authoring MDX and before opening a PR.

## Mental model

Treat docs coverage like attack-surface coverage. Public code surfaces are the
source of truth; docs are the user-facing projection. The review turn is
adversarial, evidence-led, and finding-based.

## Required checks

- Every selected pack has its required pages or an explicit reason it was
  removed.
- Every generated page is backed by code, tests, schemas, examples, changelogs,
  release notes, or CLI/API output.
- Public surfaces are either documented, intentionally internal, or explicitly
  skipped as unreleased or feature-flagged.
- Examples can be traced to source, tests, schemas, or runnable commands.
- Feature-flagged or unreleased behavior is not documented as generally
  available.
- No `HOMELANDER:` comments, bracket placeholders, `TODO`, or `TBD` remain.
- Navigation, frontmatter, local links, and docs build pass.

## Finding format

Each finding must include:

- Severity: `high`, `medium`, or `low`.
- Category.
- Affected MDX page or missing page.
- Selected pack.
- Source evidence.
- Required fix.

High-confidence factual issues block PR completion. Low-confidence product
intent gaps can remain as explicit PR questions.
