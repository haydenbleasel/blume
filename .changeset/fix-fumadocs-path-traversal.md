---
"blume": patch
---

Contain the Fumadocs migrator to the docs tree. A `pages` entry in a `meta.json` (e.g. `"../../victim"`) could resolve to a file outside the source directory and get `rename`d out of place, and an `<include>../../secret</include>` could read and inline an arbitrary file into the migrated output. Both paths now reject targets that escape the docs root — matching the Mintlify migrator's existing guard — and skip them with a warning.
