---
"blume": patch
---

Every `blume` entry point and deep import (`blume/core/project-graph.ts`, `blume/components/layout/locale-redirect.ts`, `blume/sources/sanity.ts`, `blume/hooks`, and the rest) now types from the declarations shipped in `dist/types` instead of Blume's `.ts` source. Before, a project's own `tsc` followed those imports into `node_modules/blume/src` and checked that source under the project's compiler options, so `exactOptionalPropertyTypes` reported hundreds of errors that `skipLibCheck` couldn't hide. The declarations Blume generates for its virtual modules pulled the same source into every project, and typed `blume:search-index` documents as `any`; they now resolve to declarations too.
