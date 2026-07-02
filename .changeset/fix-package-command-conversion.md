---
"blume": patch
---

Fix two package-manager conversions in ` ```package-install ` blocks. A global uninstall (`npm uninstall -g eslint`) produced the invalid `yarn remove -g eslint` for Yarn Classic; it now emits `yarn global remove eslint`, mirroring the global-add handling. And `npm ci` was rewritten as the nonsensical `yarn run ci` / `pnpm run ci`; it now maps to each manager's frozen-lockfile install (`pnpm install --frozen-lockfile`, etc.).
