---
"blume": patch
---

JSON-LD can now say what a site is and who runs it. `seo.organization` adds an **Organization** node to every page — name and URL default to the site's, with a logo, `sameAs` profiles, the email and telephone as a `ContactPoint`, and the address as a `PostalAddress` — which the WebSite and article nodes cite as `publisher`. `seo.software` adds a **SoftwareApplication** node to the homepage with the product's name, description, category, operating system, license, an `Offer` when a price is set (`0` for free software), and registry or repository `sameAs` links; `software: true` takes every default. Both need `deployment.site`, and custom pages built on `PageLayout` or `RootLayout` pick them up automatically.
