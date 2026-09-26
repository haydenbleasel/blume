---
"blume": patch
---

Translate the banner, header links, and footer per locale. The banner's `content` and link `text`, `navigation.actions`, `navigation.cta`, and `navigation.featured` labels, and `footer` link labels now accept a map of locale code to text, like tab labels do. Each page shows its locale's entry and falls back to the default locale's. Internal footer links now move into the reader's locale whenever that locale serves the page, as header links already did.
