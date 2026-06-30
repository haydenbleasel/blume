# Homelander Evaluation

Use this workflow when comparing Homelander against existing docs or OSS
codebases. The goal is to improve pack classifiers, obligations, and templates,
not to prove that one generated output is perfect.

## Comparison modes

### Existing docs analysis

Run official docs through the docs-to-pack mapper:

```bash
python3 skills/homelander/scripts/docs_eval.py \
  --repo . \
  --docs-root docs/content/docs \
  --name blume \
  --output-root .homelander-evals
```

This answers:

- Which packs the real docs imply.
- Which official pages map to each pack.
- Which official pages have no Homelander obligation analogue.

### Blind codebase generation

Add `--write-generated-stubs` to create missing generated MDX and `meta.ts`
files under the eval output folder:

```bash
python3 skills/homelander/scripts/docs_eval.py \
  --repo . \
  --docs-root docs/content/docs \
  --name blume \
  --write-generated-stubs
```

The generated docs are not intended for direct commit. They are a benchmark
artifact for comparing code-inferred docs against official docs.

### OSS target evaluation

Evaluate a public repo without modifying its source:

```bash
python3 skills/homelander/scripts/docs_eval.py \
  --clone-url https://github.com/org/repo.git \
  --name repo \
  --docs-root docs \
  --write-generated-stubs
```

If the official docs live outside the repo, clone or export them separately and
run existing docs analysis against that folder first. Keep per-target results
under `.homelander-evals/<target>/`.

## Output files

Each target writes:

- `comparison.md`: human-readable findings.
- `comparison.json`: full structured report.
- `official-docs-inventory.json`: official docs page-to-pack mapping.
- `generated-plan.json`: blind generated docs portfolio plan.
- `generated-docs/`: optional generated Blume stubs when requested.

## Interpretation

- **Official-only pack**: likely classifier miss, unless official docs include
  product intent that is not visible in code.
- **Generated-only pack**: likely classifier noise, unless official docs are
  incomplete.
- **Official page without generated analogue**: template-pack improvement
  candidate.
- **Required generated page without official match**: either useful new coverage
  or an obligation that is too strict.
- **Placeholder findings in generated stubs**: expected until an agent authors
  the docs from evidence.

Never generalize from one repository. Make pack changes after comparing several
targets from the same product class.

## Target set

Start small:

- One framework/tool repo.
- One API/product repo.
- One SDK repo.
- One CLI-heavy repo.
- One model-provider-like repo.
- One large multi-pack repo.

For each target, record whether docs are in-repo, generated from schemas, hosted
separately, or partly marketing/product-authored. Code can infer public surfaces;
it cannot infer every positioning or product-intent page.

## Per-target Codex prompt

Use this in a separate thread when evaluating a cloned target:

```text
Use the homelander skill in eval mode. Do not modify upstream source. Run scripts/docs_eval.py against this repo, write outputs under .homelander-evals/<target>, and compare official-implied packs to blind codebase-selected packs. Summarize classifier misses, noisy packs, required page mismatches, official pages without generated analogues, and template changes you recommend. Do not open a PR.
```
