---
"blume": patch
---

Only collapse a trailing `index` segment when deriving a custom page's route. A folder literally named `index` (e.g. `pages/index/foo.astro`) previously lost its segment and mapped to `/foo` instead of `/index/foo`, because every `index` part was stripped rather than just the filename.
