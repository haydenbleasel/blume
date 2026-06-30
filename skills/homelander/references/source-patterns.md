# Source Patterns

Use this reference when the evidence report needs manual follow-up.

## Public surface scanners

- **Routes**: inspect `app/`, `pages/`, `routes/`, `src/pages/`, `api/`,
  framework route manifests, and tests that call public URLs.
- **APIs**: inspect route handlers, OpenAPI/AsyncAPI specs, RPC routers,
  controller files, server actions, generated clients, and integration tests.
- **SDK exports**: inspect package `exports`, `main`, `module`, `types`,
  barrel files, generated declarations, examples, and public tests.
- **CLI commands**: inspect package `bin`, files under `bin/` or `cli/`, command
  registries, parser definitions, help output, and README examples.
- **Environment variables**: inspect `process.env`, `import.meta.env`,
  `Deno.env`, `.env.example`, deployment docs, config loaders, and schema
  validators.
- **Config**: inspect `*.config.*`, schema files, default config objects,
  `defineConfig` helpers, example projects, and type exports.
- **Schemas**: inspect Zod, Valibot, Yup, JSON Schema, OpenAPI, Prisma, SQL,
  GraphQL, protobuf, and generated type files.
- **Components**: inspect exported React/Vue/Svelte/Astro components, prop
  types, examples, registries, and component tests.

## Feature flag and unreleased detection

Treat a change as not ready for public docs when it is guarded by:

- Feature flag providers such as LaunchDarkly, GrowthBook, PostHog, Unleash, or
  in-house flag helpers.
- Variables or functions named like `flag`, `feature`, `gate`, `experiment`,
  `beta`, `alpha`, `preview`, `canary`, `rollout`, or `enabledFor`.
- Comments, tests, PR text, or changelog notes that say unreleased, internal,
  behind a flag, not launched, private beta, or experimental.
- Branches, package tags, or release notes that have not landed in the documented
  audience's default channel.

Document flagged behavior only when the docs page clearly targets that audience,
for example "private beta users" or "preview channel."

## Docs inventory scanner

Inventory should include:

- Markdown and MDX pages.
- Frontmatter title and description.
- First heading and page heading hierarchy.
- Local and external links.
- Code fences and declared languages.
- Imports and MDX components.
- Navigation files such as `meta.ts`, `_meta.*`, `mint.json`, `sidebars.*`, and
  docs framework config.
- Generated docs surfaces such as `llms.txt`, raw Markdown routes, API reference
  pages, sitemaps, and search indexes when relevant.

## Planning from evidence

Map surfaces to docs like this:

- First successful user path -> quickstart.
- Concepts required before setup makes sense -> concepts.
- Commands and flags -> CLI reference.
- Config keys, defaults, and env vars -> config reference.
- Exported SDK functions, classes, and types -> SDK reference.
- HTTP endpoints, schemas, request/response objects -> API reference.
- OpenAPI or AsyncAPI specs -> docs-framework rendered API reference first; do
  not duplicate generated endpoint tables unless the spec is missing or
  incomplete.
- Breaking changes, renamed options, migrations -> migration/change docs.

Then map those pages into packs. Do not force one product archetype. A repo can
select multiple packs when evidence supports them, such as platform app + HTTP
API + SDK + CLI.

When evidence is thin, create a smaller docs set and list remaining questions.
Do not invent positioning, support guarantees, pricing, model limits, or roadmap.
