---
"blume": patch
---

A section filter picked in the search dialog persisted after the query changed, even when the new results no longer included that section — and since the filter pills hide when fewer than two sections match, the stale filter could empty the results with no visible way to clear it. The filter now resets automatically when its section is missing from the new result pool, and the search re-runs unfiltered.
