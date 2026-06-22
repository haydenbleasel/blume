# Vision

## Product thesis

Blume is an open-source documentation system for teams who want Mintlify-level authoring speed without accepting a hosted black box or a narrow runtime bet.

The user should be able to:

1. Add a `docs/` folder or point Blume at existing Markdown.
2. Run `blume dev`.
3. Get a polished docs site with navigation, search, code blocks, API reference affordances, and content-aware metadata.
4. Add custom components, custom pages, AI, analytics, and server routes only when the project grows into them.

The product should feel like a docs tool first, not a framework starter.

## Positioning

| Compared to | Blume should win on |
| --- | --- |
| Mintlify | open source, portable builds, local ownership, deeper customization |
| Starlight | more batteries-included product layer, richer components, stronger migration story |
| Fumadocs | Astro/Vite distance, faster static-first default, less Next-specific surface area |
| Nextra | modern content model, generated runtime, stronger component/theming system |
| Docusaurus | lighter runtime, better Markdown-first DX, less boilerplate |
| Raw Astro | docs product features without assembling integrations by hand |

The short pitch:

> Blume is the docs engine I would want if Mintlify had been open source and built on Vite.

## Product principles

- Content first: Markdown, MDX, and structured frontmatter remain the source of truth.
- No app boilerplate: users should not need to understand Astro to start.
- Own the docs layer: use Astro/Vite as infrastructure, not as product identity.
- Static by default: docs should be fast, cacheable, and cheap to host.
- Dynamic when needed: AI chat, authenticated docs, feedback, OG images, preview routes, and integrations can use Astro server features.
- Customization without forking: component overrides, layouts, pages, CSS tokens, and registry installs should cover most real-world needs.
- Eject without punishment: an ejected project should become a normal Astro project that can keep using the `blume` package.
- Vercel-friendly: support analytics, speed insights, Blob, Edge Config, OG image generation, and serverless deploy paths cleanly.

## Non-goals

- Blume is not a generic site builder.
- Blume is not a long-term wrapper around Starlight.
- Blume is not a Next.js/Fumadocs clone with different defaults.
- Blume does not need React Server Components for its core docs model.
- Blume should not require Tailwind in the user's app to render the default theme.
- Blume should not force hosted search, hosted AI, or hosted analytics.

## Runtime stance

Blume generates a hidden Astro project under `.blume/` and drives Astro/Vite through the CLI.

Users can ignore Astro at first. When they need customization, they can add:

- `blume.config.ts` for project configuration
- `components.ts` or `components.tsx` for component overrides
- `theme.css` for tokens and CSS
- `pages/**/*.astro` for custom pages
- framework components such as React islands inside MDX or `.astro` pages

The hidden runtime can be ejected into an ordinary Astro project later.

## What must feel magical

- `blume dev` should work from a folder of docs.
- Missing nav should be inferred from files and metadata.
- Search should work without a hosted service.
- API reference blocks should look good without hand-tuning.
- Frontmatter errors should point to the exact file, key, and fix.
- Theme changes should hot reload.
- Adding a React island should feel normal for React users.
- Static deploys should be boring.

## What should stay explicit

- Server-only features should be configured intentionally.
- AI should require a clear model/auth/runtime choice.
- Authenticated docs should be a server-mode feature.
- Deep theme replacement should be source-level and visible.
- Ejecting should be a one-way ownership step, even if the `blume` package remains usable.

## Success criteria

Blume is successful when:

- a user can migrate a small Mintlify docs site in under 10 minutes
- a user can build and deploy a static docs site without writing app boilerplate
- a user can add one custom interactive component without learning Blume internals
- a user can inspect the generated Astro project and understand the runtime
- the default site scores well on Core Web Vitals
- startup time and HMR feel Vite-native
- open-source contributors can work on components and theme without a hosted platform
