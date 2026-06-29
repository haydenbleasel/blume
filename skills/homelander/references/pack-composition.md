# Pack Composition

Homelander builds a docs portfolio from composable packs. Packs are not mutually
exclusive product categories. A single repo can select platform app + HTTP API +
model provider + SDK + CLI + migration docs.

## Pack model

Each pack has:

- Evidence signals from code surfaces.
- A confidence score.
- Output obligations: folders, MDX files, and optional Blume `meta.ts`.
- Review obligations checked in the DeepSec-style review turn.

## Packs

- `site-shell`: index, getting started, base navigation, global concepts.
- `platform-app`: dashboards, projects, organizations, users, billing, auth.
- `http-api`: endpoints, auth, errors, pagination, rate limits, schemas.
- `model-provider`: models, capabilities, parameters, streaming, tokens, safety.
- `sdk-library`: install, imports, public exports, examples, types.
- `cli-tool`: commands, flags, env vars, config.
- `framework-tool`: config, plugins, adapters, build/runtime behavior.
- `integrations`: providers, webhooks, OAuth apps, external setup.
- `migration`: version changes, breaking changes, upgrade steps.

## Selection policy

Use `--packs auto` by default. Override only when:

- The user explicitly asks for or excludes a docs surface.
- Repo evidence clearly supports a pack that the classifier missed.
- Repo evidence clearly proves a selected pack is incidental or internal.

Use `--include-packs api,models,sdk` for forced inclusion. Use
`--exclude-packs billing,integrations` to suppress noisy or out-of-scope packs.

## Output contract

Allowed generated or modified files:

- MDX pages.
- Docs folders.
- Blume `meta.ts` navigation files.
- Minimal `blume.config.ts` only through the repo's `blume init` bootstrap path.

Do not generate screenshots, fake OpenAPI specs, custom app code, package
dependencies, or marketing-heavy pages in v1. Evidence and plan artifacts under
`.homelander/` stay uncommitted by default.
