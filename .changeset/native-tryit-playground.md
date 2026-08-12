---
"blume": minor
---

Try It playground on native OpenAPI operation pages. Each operation ships an interactive **Try it** panel: a form generated from the operation's parameters and request-body schema, prefilled from the spec's examples, with a server picker fed by the spec's `servers` and auth inputs matching the operation's security schemes (bearer, API key, basic, and a token paste field for OAuth2). Values typed into the form update the generated code samples live, and **Send** fires the request directly from the browser — with an optional proxy for APIs that don't allow cross-origin requests from the docs site (`openapi.playground.proxy`: a URL of your own, or `true` for the built-in `/_api-proxy` server route). The panel is server-rendered collapsed and loads its JavaScript only when a reader first opens it; it's on by default with the native renderer, and `playground: false` turns it off.
