---
"blume": patch
---

⌘K / Ctrl+K now toggles the search dialog: pressing it while the dialog is open closes it, matching how ⌘I toggles the Ask AI panel. Previously the shortcut unconditionally re-opened, calling `showModal()` on an already-open dialog — a silent no-op on evergreen browsers but an `InvalidStateError` on older engines. The `/` shortcut stays open-only, and `open()` itself now guards against an already-open dialog.
