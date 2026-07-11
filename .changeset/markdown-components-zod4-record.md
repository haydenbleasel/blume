---
"blume": patch
---

Fix `ai.markdownComponents` crashing config validation in projects that resolve Zod 4. The schema used the single-argument `z.record(...)` form, which Zod 4 rejects at schema-construction time, so any config parse failed before your settings were even read; it now uses the dual-compatible two-argument form.
