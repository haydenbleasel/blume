---
"blume": major
---

Replace `deployment.adapter` and `deployment.output` with deployment adapters imported from `blume/deploy`. `deployment` now takes the descriptor one of `vercel()`, `netlify()`, `cloudflare()`, or `node()` returns — each accepting `site`, `base`, and `output`, plus any option of the underlying `@astrojs/*` adapter, forwarded verbatim — or the plain `{ site, base }` form for a static build on any host. Naming a host adapter switches the build to server output there; pass `output: "static"` to keep a static build on that host with its site detection and platform files. Leaving `deployment` unset still means a static build, so zero-config sites are unchanged.

```ts
import { defineConfig } from "blume";
import { vercel } from "blume/deploy";

export default defineConfig({
  // was: deployment: { output: "server", adapter: "vercel" }
  deployment: vercel({ isr: { expiration: 60 } }),
});
```

Each adapter is a plain, JSON-serializable descriptor that declares its `@astrojs/*` package as a runtime dependency, so the generated `package.json`, the missing-dependency preflight, `blume doctor`, and the secrets check read the descriptor instead of switching on an adapter name. Everything a target does differently — the generated `astro.config.mjs` adapter entry, where its bundle and static assets land, which `_redirects`/`vercel.json`/`_headers` files a static build writes, `Accept: text/markdown` negotiation, Vercel's function-bundle audit, and platform env detection for `site` — lives with that adapter.

Migration: `deployment: { output: "server", adapter: "vercel" }` becomes `deployment: vercel()`, and the same for `netlify()`, `cloudflare()`, and `node()`; `site` and `base` move into the adapter's options (`vercel({ site, base })`). A static config that only set `site` or `base` needs no change. The `--adapter`, `--output`, and `--base` flags on `blume build` are gone: set the adapter in `blume.config.ts`. Server output is no longer inferred from the platform env — name the host adapter — while `site` detection on Vercel, Netlify, and Cloudflare Pages works as before. The old object form fails validation with a hint pointing at the adapter form.
