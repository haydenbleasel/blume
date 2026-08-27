---
"blume": patch
---

Localize the "Open in chat" prompt. The prompt handed to the chat provider ("Read `<url>` so I can ask you questions about this page.") was hardcoded in English regardless of the site's locale. It now comes from the UI dictionary as `actions.openInChatPrompt` — with `{url}` replaced by the page's raw-Markdown URL at load time — so localized sites send a localized prompt, every shipped starter pack carries a translation, and `i18n.ui` can override the wording like any other chrome string.
