---
"blume": minor
---

Add `navigation.actions` and `navigation.cta` — plain links in the header, and the one filled button. `navigation.featured` pins secondary links to the top of the sidebar and there was no header slot at all, so a docs site arriving from a hosted platform lost whatever its old top bar asked the reader to do. `cta` is singular by contract. Both hide below the `sm` breakpoint, where the header has room for the logo and the drawer toggle and nothing else — except `cta` on a page with no navigation toggle, where it stays, since nothing else can surface it on a phone.
