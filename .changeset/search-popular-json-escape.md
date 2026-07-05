---
"blume": patch
---

Escape `<` in the search dialog's popular-pages JSON payload, so a page title containing `</script>` can no longer terminate the inline script and inject markup.
