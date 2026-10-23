---
"blume": patch
---

The API reference now follows the site's language instead of always showing English. An operation page's headings, parameter and schema tables, authorization, Try it panel and its error messages, and the AsyncAPI message composer follow the page's locale, as do the fields of hand-written API pages. The labels the reference adds to the sidebar (its Overview page, and the Operations, Webhooks, and GraphQL kind groups) use the default locale's words. They're the new `reference` UI strings, translated in every built-in language pack and overridable under `i18n.ui`. Only the labels change: the reference's URLs stay the same in every language.
