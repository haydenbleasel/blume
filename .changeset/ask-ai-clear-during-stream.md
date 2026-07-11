---
"blume": patch
---

Stop "Clear conversation" from resurrecting an orphaned answer bubble while a reply is still streaming. Clearing mid-answer emptied the panel, but the in-flight stream kept re-appending its assistant message to the cleared conversation — a growing answer with no question above it. Clearing now aborts the in-flight request and revokes the stream's right to write into the conversation, and asking a new question right after a clear works as before.
