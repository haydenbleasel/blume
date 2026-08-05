---
"blume": minor
---

Add per-type frontmatter schemas via `content.types.<type>.frontmatter`. Where `frontmatter.extend` declares custom keys site-wide, a per-type declaration scopes them to pages whose frontmatter `type` matches — so a project can require an RFC's `status` or a runbook's `service` without loosening every other page. Keys follow the same rules as `extend`: any Standard Schema library validates them (Zod at whatever version the project installs, Valibot, ArkType), every declared key is checked on every page of the type so required schemas enforce type-wide, and validated values land on the page record's `custom` field. A declaration for `content.defaultType` applies to pages that set no `type`, a key declared only for another type stays unknown elsewhere (typo-catching is unchanged), and a key can't be declared both site-wide and per-type.
