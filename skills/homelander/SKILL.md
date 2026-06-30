---
name: homelander
description: Agent-native DeepSec-style docs authoring framework for building or maintaining Blume documentation directly from a codebase. Use when asked to generate docs from an empty repo or Blume scaffold, classify public code surfaces into composable docs template packs, create Markdown/MDX folders and Blume meta.ts navigation, compare code or merged PRs against docs, ignore feature-flagged or unreleased behavior, run evidence-based docs review, validate docs, or open focused blume/* documentation PRs from Codex, Cursor, Claude, or scheduled automations.
---

# Homelander

## Overview

Use Homelander as a docs authoring harness for agent-native execution. The skill
is the UX and policy layer; bundled scripts, pack templates, validators, and
references are the reliable substrate. The agent invokes the tools because the
user or automation invoked the skill.

Homelander builds a **docs portfolio**, not a single archetype. A repo can select
multiple composable packs, such as platform app + HTTP API + model provider +
SDK + CLI. The output is a Blume docs source tree: MDX files, folders, and
`meta.ts` navigation.

## Modes

- **Init mode**: start from no docs, or a minimal `blume init` scaffold, and
  build a first useful docs tree from code.
- **Maintenance mode**: compare recent merged work and current public surfaces
  against existing docs, update stale MDX, validate, and open or update a
  focused `blume/*` PR.
- **Audit-only mode**: inspect, classify, plan, and produce findings without
  editing files.

## Required First Steps

1. Read repo instructions: `AGENTS.md`, `CLAUDE.md`, Cursor rules, contribution
   docs, PR template, and package scripts.
2. Inspect branch and worktree. Do not overwrite unrelated user changes.
3. If init mode and no docs project exists, run the repo-appropriate Blume
   bootstrap first, such as `blume init`, then let Homelander replace the
   scaffold with evidence-backed docs.
4. Run the harness from the repo root:

```bash
python3 skills/homelander/scripts/docs_harness.py \
  --repo . \
  --mode init \
  --packs auto \
  --output .homelander/evidence.md \
  --json-output .homelander/evidence.json \
  --plan-output .homelander/docs-plan.json
```

Use `--include-packs api,models,sdk` or `--exclude-packs billing,integrations`
when the user or repo policy constrains the docs portfolio. Use `--write-stubs`
only after reviewing the plan.

## Workflow

1. **Scan and classify**
   - Run `scripts/docs_harness.py`.
   - Read `.homelander/evidence.md` and `.homelander/docs-plan.json`.
   - Read `references/pack-composition.md` when pack selection or output shape
     needs interpretation.

2. **Plan the docs portfolio**
   - Treat selected packs as docs obligations.
   - Keep skipped packs skipped unless there is clear evidence or user override.
   - The core outputs are MDX pages, folders, and Blume `meta.ts` files.
   - When a verified OpenAPI or AsyncAPI spec exists, render it through Blume,
     Mintlify, or the repo's existing docs framework instead of duplicating the
     reference by hand.
   - Do not generate screenshots, fake OpenAPI specs, app code, dependencies, or
     marketing-heavy pages in v1.

3. **Write stubs and author MDX**
   - Run the harness again with `--write-stubs` when the plan is acceptable.
   - Replace every `HOMELANDER:` comment, bracket placeholder, `TODO`, and `TBD`
     with sourced content before PR.
   - Use code, schemas, CLI help, generated types, tests, examples, changelogs,
     and release notes as primary evidence.
   - Do not document feature-flagged, private, experimental, or unreleased
     behavior as generally available.

4. **Run the DeepSec-style review turn**
   - Re-run the harness after authoring.
   - Read `references/review-turn.md`.
   - Treat review findings like security findings: evidence first, severity,
     affected page, pack, required fix.
   - Fix high-confidence factual issues before opening a PR.
   - Leave product-intent gaps as explicit PR questions.

5. **Validate and PR**
   - Run the repo docs build and strongest reasonable focused checks.
   - If no docs changed, report the no-op evidence and do not open a PR.
   - If docs changed, create or update a focused `blume/*` branch and PR.
   - Do not commit `.homelander/` artifacts unless the repo explicitly wants
     audit artifacts in source control.

## Resources

- `scripts/docs_harness.py`: scanner, pack classifier, docs portfolio planner,
  safe stub writer, and DeepSec-style review reporter.
- `references/pack-composition.md`: pack model, selected/skipped pack policy, and
  output contract.
- `references/source-patterns.md`: public surface scanners and unreleased-work
  detection.
- `references/review-turn.md`: required adversarial review procedure.
- `references/operating-procedure.md`: mode-specific workflow and PR gates.
- `references/automation-examples.md`: Codex, Cursor, Claude, and scheduled run
  examples.
- `assets/packs/*`: composable MDX templates for the selected docs packs.
