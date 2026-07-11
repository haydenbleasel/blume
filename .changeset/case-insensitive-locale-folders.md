---
"blume": patch
---

Match locale folders and dot suffixes case-insensitively, the way BCP 47 codes are defined. A configured `pt-BR` with the conventional lowercase `pt-br/` folder (or an `intro.pt-br.mdx` suffix under the `dot` parser) previously fell through as default-locale content at a literal `/pt-br/…` route — and the unconfigured-locale warning, which already compared case-insensitively, stayed silent about it. Those files now route as the configured locale, with the configured casing in routes and labels.
