---
"blume": patch
---

Fix `package-install` tabs that passed a `--` through or used `--save-exact`. A `create` command with initializer flags (`npm create vite@latest my-app -- --template react-ts`) now keeps the `--` only on the npm tab, so pnpm, Yarn, Bun, nub, and aube no longer pass it to the initializer, which then ignored the flags after it. Writing the command without `--` now adds it on the npm tab, which needs it. `run` commands with script arguments (`npm run dev -- --port 3000`) no longer pass a literal `--` to the script on pnpm and Yarn, or render a second one on npm. `--save-exact` and `--exact` now render as `-E`, which every manager accepts. Yarn rejected `--save-exact`, pnpm rejected `--exact`, and npm ignored `--exact`.
