---
"blume": patch
---

Stop routing by browser language (`i18n.routeByBrowserLanguage`) from moving a reader who is already browsing the site. Following a link to the default language's home page could send them to their browser's language, because the page still reported where they first arrived from. Under `deployment.base`, a visitor who arrives from elsewhere on the same origin now counts as coming from outside the site, and is routed.
