---
"blume": patch
---

Stop `blume audit` flagging the changelog RSS feed link in llms.txt as a stale entry. The stale-entry check compared each llms.txt target against built pages only, but the generator itself links non-page assets — the changelog RSS feed — so a target the static file index serves now counts as valid, the same way redirect targets may land on a served asset.
