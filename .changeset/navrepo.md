---
"blume": minor
---

`navigation.repo` now takes a URL as well as a boolean. `github` drives the per-page edit link, the header mark and the agent manifest's `repository` together, so a project whose docs repo is private had to unset all three — and then had no way to show a mark at all. An absolute URL points it anywhere on GitHub, an organization for instance, while `true` keeps deriving it from `github` and `false` still hides it.
