---
"blume": patch
---

Check the dev lock before regenerating `.blume/`, and record the server's port in it. A second `blume dev` previously regenerated the runtime (with its own port baked in) before noticing the lock, so even a refused invocation churned the running server's generated files on its way out; it now refuses before touching anything. The lock file (`.blume/dev.lock`) stores `{pid, port}` — updated with the actual bound port if Vite bumps a busy one — so the refusal messages from `dev`, `build`, `check`, and `eject` point at the live server's URL (e.g. "A `blume dev` server is already running at http://localhost:3001 — reuse that server"), steering callers (especially agents) toward reusing the running server instead of killing it.
