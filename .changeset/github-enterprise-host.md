---
"blume": minor
---

Add `github.host` so docs hosted on a GitHub Enterprise instance get working repo links. Every repo-derived URL — the header mark, per-page edit links, the agent manifest's `repository`, the OG card's slug, and `<GithubInfo>` — was built against a hardcoded `github.com`, so an Enterprise repo produced links into the public site. `host` defaults to `https://github.com`, must be an HTTP(S) URL, and is normalized to its origin so nothing lands mid-link. The REST base `<GithubInfo>` queries is derived from it (an `api.` subdomain for an Enterprise Cloud data-residency tenant, `/api/v3` for Enterprise Server) or set outright with `github.api`; a `GITHUB_TOKEN` is now withheld from a cleartext-HTTP API base rather than sent over the wire.
