---
"blume": patch
---

`usePage()` and `useBlume()` now return the page being viewed after a client-side navigation. They used to keep answering with the first page's route, title, and navigation for the rest of the visit, so an island on a page reached by a link, or after switching language, read the wrong page. An island kept across navigations with `transition:persist` now updates too.
