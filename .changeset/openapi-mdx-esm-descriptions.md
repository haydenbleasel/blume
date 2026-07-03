---
"blume": patch
---

OpenAPI descriptions that start a line with `import` or `export` no longer crash the build. Operation and overview descriptions are embedded as markdown in generated MDX pages, and MDX parses lines beginning with those keywords as ESM — so common API prose like "import the SDK and call the endpoint" failed compilation with an acorn parse error. The keyword's first letter is now entity-escaped alongside the existing `<>{}` neutralization; the rendered text is unchanged.
