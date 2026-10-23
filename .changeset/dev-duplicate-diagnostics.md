---
"blume": patch
---

`blume dev` no longer prints the same content diagnostics twice when the dev server starts on another port because the requested one is taken. With `deployment.site` configured, it also skips the rescan that port change used to trigger, since the site doesn't depend on the port.
