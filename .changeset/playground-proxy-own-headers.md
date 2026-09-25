---
"blume": patch
---

The API playground's built-in proxy (`playground: { proxy: true }`) now forwards only the headers the Try it panel sets itself: the credentials and header parameters filled in, and the body's `Content-Type`. It used to forward every request header except a handful, so credentials the browser or the host attached on their own reached the documented API: HTTP Basic credentials for a password-protected docs site, a Cloudflare Access `cf-access-jwt-assertion`, Vercel's `x-vercel-oidc-token`, and `X-Forwarded-For`/`X-Real-IP`. Platform headers are never forwarded, even when a spec declares a header parameter with the same name.
