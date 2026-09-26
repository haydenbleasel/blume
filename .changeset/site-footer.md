---
"blume": minor
---

Add a site footer: one row, as tall as the header, below the content on every page. Your repository link moves there from the header (see the header changes), as the first of the footer's icons, and `footer` in `blume.config.ts` adds the rest: `links`, a list of `{ label, href }` shown on one side, and `socials`, profile URLs keyed by platform (`x`, `discord`, `linkedin`, `youtube`, `website`, and more) shown as brand icons on the other, both in the order written. A `github` social replaces the repository link, and `navigation.repo` still hides it or points it elsewhere. Custom pages built on `PageLayout` show the footer too, unless they fill the layout's `footer` slot. A `Footer` layout override still replaces it, and `blume add footer` copies the built-in into your project to edit. A site with no repository, links, or profiles has no footer.
