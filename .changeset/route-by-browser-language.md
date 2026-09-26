---
"blume": patch
---

Add `i18n.routeByBrowserLanguage`, which sends visitors who land on the default language's home page to the home page in their browser's preferred language. Blume tries each language the browser prefers, in order, matching an exact locale code and then the base language, and a visitor whose first match is the default language stays. Picking a language with the switcher stops the routing for that reader, and only visitors arriving from outside the site are routed. The redirect runs in the browser before the page paints, so it works on static hosts. It's off by default.
