---
"blume": patch
---

Add a `vlt` tab to the `package-install` block, alongside npm, pnpm, yarn, bun, nub, and aube. vlt spells its commands as npm does, so `npm i -D typescript` becomes `vlt install -D typescript` and `npm ci` becomes `vlt ci`. `npx …` becomes `vlx …`, with a `--` before the binary's flags, which vlt would otherwise read as its own, and a bare `npm init` becomes `vlt init`. An install block may also be written with a `vlt` or `vlx` command as its input.
