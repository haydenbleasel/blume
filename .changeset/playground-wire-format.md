---
"blume": patch
---

The Try it panel and the code samples now send requests the way the spec describes them. Array and object parameters follow their `style` and `explode`, with OpenAPI's defaults when the spec sets none: `tags: ["dog", "cat"]` becomes `?tags=dog&tags=cat` rather than a URL-encoded JSON array, a path array becomes `1,2`, and a `deepObject` filter becomes `filter[color]=red`, with `spaceDelimited`, `pipeDelimited`, `label`, and `matrix` supported too. An `application/x-www-form-urlencoded` body is sent as `name=value` pairs (following its `encoding`), and a `multipart/form-data` body as form fields: curl uses `--form-string`, JavaScript a `FormData`, and Python `files=`. Before, both were sent as JSON. A `text/plain` or XML body is sent as written, without being blocked as "Invalid JSON", and its string example is no longer wrapped in quotes.

Examples that `$ref` an entry under `#/components/examples` now prefill the panel and the response samples instead of being replaced by a generated placeholder. A GraphQL endpoint keeps its trailing slash (`https://host/graphql/` was sent to `…/graphql`). The HEAD curl sample uses `--head` so it no longer waits for a body that never comes, and the Python sample for TRACE uses `requests.request("TRACE", …)`, since `requests.trace` doesn't exist.
