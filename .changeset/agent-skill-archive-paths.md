---
"blume": patch
---

A file path longer than 100 bytes inside a published agent skill no longer fails `blume build`: the skill's `.tar.gz` stores it in the ustar `prefix` field up to 255 bytes and in a PAX extended header beyond that, so standard `tar` readers unpack it at its full path. Two skill directories that declare the same `name` now publish one index entry, from the directory that sorts first, with a build warning naming both, instead of two entries for one artifact whose digest could not match what was served.
