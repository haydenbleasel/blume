---
"blume": patch
---

Fix `blume dev` and `blume build` failing on Windows with `Cannot find module '@astrojs/mdx'` under Bun's isolated linker. The hidden runtime's `node_modules` link is now a directory symlink (falling back to a junction where symlinks need elevated privileges), because Windows can't follow the relative symlinks Bun writes into Blume's dependency directory when they're reached through a junction.
