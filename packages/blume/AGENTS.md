# Blume agent guidance

This package ships agent skills for working with Blume documentation projects. Before modifying a Blume project, read the relevant skill. Each skill's canonical instructions live in its `SKILL.md`:

- `./skills/blume/SKILL.md` — build and maintain a Blume site: scaffolding, writing Markdown/MDX, `blume.config.ts`, navigation, search, theming, SEO, and the `blume` CLI.
- `./skills/blume-migrate/SKILL.md` — migrate an existing docs site (Mintlify, Docusaurus, Fumadocs, Nextra, Starlight, or another framework) to Blume.
- `./skills/blume-update-docs/SKILL.md` — audit a Blume docs site against the product it documents, fix stale pages, and open a maintenance pull request.

Use the relevant `SKILL.md` as the source of truth for Blume-specific workflows. The full Blume documentation is bundled under `./docs/`, and the `blume` skill points at it.

To register the skills with your agent harness instead of reading them out of `node_modules`:

```bash
npx skills add haydenbleasel/blume
```

## Working in the Blume repository

If you are reading this inside a checkout of the Blume monorepo rather than an installed package, `packages/blume/skills` and `packages/blume/docs` are gitignored copies that `bun install` and `prepack` regenerate. Edit the repo-root `skills/` directory and `apps/docs/content/docs` instead, and follow the repo-root `AGENTS.md` for contributor guidance.
