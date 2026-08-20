---
"blume": patch
---

Keep the Ask AI panel alive across page navigations. The island now rides the client router with `transition:persist`, so the conversation, a draft question, and the open panel all survive moving between pages instead of resetting on every click. The island re-anchors its portaled panel and the desktop content-push attribute after each swap, and the mobile overlay's focus containment re-applies to the new page's content.
