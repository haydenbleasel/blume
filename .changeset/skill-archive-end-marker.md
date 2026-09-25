---
"blume": patch
---

An agent skill's `.tar.gz` now always ends with the two zero blocks that mark the end of a tar archive. A skill whose files filled the archive to within a block of its 10 KB record ended with one zero block or none, and GNU `tar` warned "A lone zero block" while unpacking it. Archives that already ended correctly keep the same bytes and digest.
