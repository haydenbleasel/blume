---
"blume": patch
---

Every tab panel now has the `tabpanel` role its tab points at, including the panels of a `<CodeGroup>`, a TypeScript/JavaScript pair, and a nested tab group, which had none. Panels of `<Tabs dropdown>` no longer claim the `tabpanel` role, since that layout shows a select instead of tabs to label them.
