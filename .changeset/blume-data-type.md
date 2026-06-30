---
"blume": patch
---

Document and type the `blume:data` module that custom pages import. Export `BlumeData` (and its parts — `BlumeDataConfig`, `BlumeRoute`, `BlumeFeed`, `BlumeLogo`, `BlumeFavicon`, `BlumeBanner`, `BlumeDataI18n`, `UIStrings`) from `blume`, so a custom `.astro` page can `import type { BlumeData } from "blume"` instead of reading the generator to learn the shape. The generated runtime now declares `blume:data` with that type, and `buildRuntimeData` is annotated with it so the exported type and the emitted JSON can't drift. The custom-pages guide's data table is expanded to the full surface — `config` (now listing favicon/appleIcon/banner/theme/site/repoUrl/search/i18n/mcp/og/analytics/...), plus `navigation`, `navigationByLocale`, `routes`, `feeds`, `fontCssVars`, `ui`, and `uiByLocale`.
