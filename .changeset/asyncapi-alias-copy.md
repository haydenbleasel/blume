---
"blume": patch
---

Give each AsyncAPI channel or operation that references the same component its own copy before traits merge. The aliases shared one object, so the first merge leaked into the second and stripped `traits` from the component table entry itself.
