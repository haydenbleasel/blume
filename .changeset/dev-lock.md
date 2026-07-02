---
"blume": patch
---

Guard the shared `.blume` runtime dir with a dev lock. `blume dev` continuously regenerates and serves `.blume`, so a `blume build` or `blume eject` run in another shell could regenerate or delete it out from under the live Vite server and corrupt the session. `dev` now writes a PID lock, and `build`/`eject` refuse with a clear message while it's held (stale locks from a crashed dev server are ignored). `blume sync` is unaffected — it's designed to refresh content while `dev` is running.
