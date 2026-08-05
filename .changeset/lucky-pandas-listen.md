---
"blume": patch
---

Emit `_headers` on a Cloudflare server build, so the agent-discovery surface it already generates is actually advertised.

`buildHomeLinkHeader()` had three consumers and every one excluded this deployment: the `_headers` writer returned early unless `output === "static"`, the Vercel routing-config injection only runs for that adapter, and the middleware that calls `res.setHeader("Link", …)` is mounted on `astro:server:setup`, so it is dev-only. A Cloudflare _server_ build therefore served no homepage `Link` header at all, and no `Content-Type` on the extensionless well-known files — an API catalog went out with no media type rather than `application/linkset+json`.

The gate is now `readsHeaderFiles()`, which is true for any static build and additionally for a Cloudflare server build: the Worker serves `dist/client` through its ASSETS binding, and Workers static assets honor `_headers` from that directory exactly as Pages does. Node server builds stay excluded, because the standalone server's static handler ignores the file and writing it there would be inert. Vercel server builds stay excluded because their headers arrive through the routing config, which this would duplicate.

Two related corrections fell out of testing it against a real Cloudflare server build, and both apply to static builds as well:

- The user opt-out is now checked at `public/_headers` rather than in `dist`. `@astrojs/cloudflare` writes its own `_headers` during the build (an immutable `Cache-Control` for `/_astro/*`), so testing `dist` read an adapter-generated file as a user opt-out and skipped silently — the fix above would not have fired without this.
- When a `_headers` already exists in the output, its rules are preserved and the generated ones are appended, so the adapter's caching rule and Blume's discovery rules coexist. On a static build this changes behavior for a `_headers` that reached `dist` some way other than `public/` (an integration writing it directly, say): that file previously suppressed generation entirely and is now appended to. Shipping `public/_headers` remains the opt-out.

The charset rules in this file remain redundant on a server build, where the runtime endpoint sets `Content-Type` on the Response itself; they are harmless, because a static-asset rule only applies to a file served from that directory. The `Link` and well-known media-type rules are the part that was missing, and the previous comment's reasoning — that server adapters set Content-Type themselves — was true of the charset rules only and had been applied to the whole file.
