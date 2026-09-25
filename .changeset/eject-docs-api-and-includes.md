---
"blume": patch
---

`blume eject` now writes the JSON docs API (`/api/docs/…` and `/openapi.json`) into the ejected app, which its `llms.txt`, homepage `Link` header, and not-found page already pointed to, so those links no longer 404. The ejected `src/generated/includes.json` now lists partials and their pages relative to the project instead of as absolute paths from the machine that ran eject, so editing a partial still refreshes the pages that include it in any checkout.
