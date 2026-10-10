---
"blume": minor
---

Add SEO options for docs that live inside another site: shared JSON-LD entity ids and attribution (`seo.jsonLd`), a default social image in place of generated cards (`seo.og.image`), publication dates from git for pages without a front matter `date` (`seo.datePublished: "git"`), and hreflang alternates in the sitemap (`seo.sitemap: { alternates: true }`). Page JSON-LD now also carries the page's social image and credits its front matter `authors`, and hreflang links leave out `noindex`, hidden, and canonical-elsewhere translations.
