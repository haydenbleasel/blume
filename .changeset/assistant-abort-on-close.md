---
"blume": patch
---

Closing the assistant panel mid-answer now stops the model call. The generated assistant route passes the request's abort signal to the model, which used to keep generating, and billing, the rest of the answer after the reader left.
