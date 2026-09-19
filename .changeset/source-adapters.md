---
"blume": major
---

Replace the `content.sources` `{ type: "…" }` objects with content source adapters. Each entry is now a descriptor returned by a factory imported from `blume/sources` — `filesystem({ root, include, exclude })`, `mdxRemote({ github, url, files, include })`, `githubReleases({ owner, repo, limit, prereleases, drafts })`, `sanity({ projectId, dataset, query, fields, apiVersion })`, `notion({ database, properties, publishedValue, concurrency })`, `obsidian({ vault, exclude })`, or `custom(source)` for any `ContentSource` implementation. `prefix` and `pollInterval` are shared options every adapter accepts, so each factory declares only what is specific to it.

Each adapter is a plain descriptor that owns its options, the SDK it needs, and the env vars it reads, so the generated project's `package.json`, the secrets check at `blume dev`/`build`, `blume doctor`, and the ejected site all read the descriptor instead of switching on a source name: `notion()` declares `@notionhq/client` and `NOTION_TOKEN`, `sanity()` declares `@sanity/client` and `SANITY_TOKEN`, and `githubReleases()`/`mdxRemote()` declare `GITHUB_TOKEN`.

The top-level `content.root`, `content.include`, and `content.exclude` remain the zero-config shorthand and desugar to exactly one `filesystem()` source when `sources` is absent. They are rejected beside `sources` — move them into the `filesystem()` entry — so the resolved config has one source of truth and the `docs` collection always roots at the first `filesystem()` source.

Migration:

```ts
import { defineConfig } from "blume";
import { filesystem, githubReleases } from "blume/sources";

export default defineConfig({
  content: {
    // was: root: "content", sources: [{ type: "filesystem", root: "content" }, { type: "github-releases", owner, repo, prefix }]
    sources: [
      filesystem({ root: "content" }),
      githubReleases({ owner: "acme", repo: "sdk", prefix: "changelog" }),
    ],
  },
});
```

`{ type: "mdx-remote", … }` becomes `mdxRemote({ … })`, `{ type: "sanity", … }` becomes `sanity({ … })`, `{ type: "notion", … }` becomes `notion({ … })`, `{ type: "obsidian", … }` becomes `obsidian({ … })`, and `{ type: "custom", source }` becomes `custom(source)`; every other field moves into the call unchanged. A leftover `type` object fails validation with the factory that replaces it.
