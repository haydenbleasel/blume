---
"blume": patch
---

`blume build` now audits the Vercel function bundle after a server build and fails when the bundle is missing a package its server code imports. The Vercel adapter's dependency trace silently drops any bare import it can't resolve from the project root — under an isolated linker (pnpm, Bun's isolated mode) that includes Blume's own runtime dependencies, such as the MCP server's `@modelcontextprotocol/sdk` — and the deployed function then fails on every request with `FUNCTION_INVOCATION_FAILED` while the build, CI, and warm-cache previews all stay green. The build now reports each missing package with the chunk that imports it and the `npm install -D …` line that fixes it; a missing Blume dependency fails the build, a project's own missing external is a warning.
