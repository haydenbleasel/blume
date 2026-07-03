---
"blume": patch
---

Split the `logo` config into an `image` mark and a `text` wordmark so a site can show an image-only logo, a text-only logo, or both. The object form is now `{ image, text, href }`: `image` takes the same value as the string shorthand (a single path, or `{ light, dark, alt }` for themed artwork), and `text` controls the wordmark independently — omit it to fall back to the site title (the previous behavior), set `text: ""` to render the mark alone (handy when the logo image already carries the wordmark), or set `text` with no `image` for a text-only logo. The bare-string shorthand (`logo: "/logo.svg"`) is unchanged; the old flat object form `{ light, dark, alt }` now nests under `image`.
