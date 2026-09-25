---
"blume": patch
---

A schema with both properties and a `oneOf`/`anyOf` now shows its shared properties above the variants. Before, `{ properties: { amount, currency }, oneOf: [Card, BankAccount] }` showed only "One of Card | BankAccount". An OpenAPI spec whose `operationId`, tag, summary, or description YAML reads as a number (`operationId: 404`, `tags: [2024]`) now loads, using the number as text, where it used to fail with "text.normalize is not a function". The request and response tabs' Left and Right arrow keys follow the reading direction on right-to-left pages, as `<Tabs>` does.
