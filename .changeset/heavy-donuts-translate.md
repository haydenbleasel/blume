---
"blume": minor
---

Add `blume translate`: agent-driven i18n translation with a committed freshness ledger and a CI drift gate.

`blume translate --claude` (or `--codex`) finds every default-locale page that is missing or outdated in each configured locale and translates it headlessly with your local agent CLI — Blume builds the prompts, disables the agent's tools, validates each reply's structure (frontmatter reconstructed from the source, code-fence counts preserved), and writes the files itself. A committed `blume.translations.json` ledger records the source hash behind every translation, so reruns are incremental, and hand-authored translations are adopted rather than overwritten (only `--force` retranslates them). Under the `dir` parser, folder-nav `meta.ts` titles are translated too, copying every other key verbatim so per-locale sidebars keep their ordering. `blume translate --check` is the read-only CI gate: it exits non-zero when any translation is missing or stale, with `--json` emitting the shared diagnostics report shape.
