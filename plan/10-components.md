# Components

## Goals

Blume should ship a rich docs component system out of the box.

Components should be:

- accessible
- themeable
- MDX-friendly
- Astro-first where static
- island-based where interactive
- overridable through `components.ts`
- installable as source through `blume add`

## Implementation stance

Default components should live behind the `blume/components` subpath export from the single `blume` package.

Static components should be `.astro` where possible:

- layout
- callouts
- cards
- steps
- code frame shell
- API tables
- page header/footer

Interactive components can be React islands:

- search modal
- tabs when client state is needed
- API playground
- Ask AI
- feedback widget
- theme toggle

The component registry can use shadcn-style source distribution, but the components are Blume-owned and Astro-aware.

## Core components

### Layout

- `DocsLayout`
- `Header`
- `Sidebar`
- `MobileNav`
- `TableOfContents`
- `Breadcrumbs`
- `Pagination`
- `Footer`

### Content

- `Callout`
- `Card`
- `CardGroup`
- `Steps`
- `Accordion`
- `Tabs`
- `Badge`
- `CodeBlock`
- `CodeGroup`
- `FileTree`
- `Icon`
- `Video`
- `Frame`

### API/reference

- `Endpoint`
- `ParameterTable`
- `ResponseExample`
- `RequestExample`
- `SchemaViewer`
- `AuthMethod`
- `CodeSamples`

### Product/docs utilities

- `Search`
- `AskAI`
- `Feedback`
- `EditOnGitHub`
- `LastUpdated`
- `VersionSelector`
- `LanguageSelector`

## MDX usage

```mdx
<Callout type="warning" title="Heads up">
  This API is experimental.
</Callout>

<CardGroup cols={2}>
  <Card title="Quickstart" href="/quickstart" />
  <Card title="API Reference" href="/api" />
</CardGroup>
```

## Accessibility requirements

Every interactive component must define:

- keyboard behavior
- focus management
- ARIA roles/labels where needed
- reduced motion behavior
- server-rendered fallback where possible

## Styling requirements

Components should use:

- CSS variables for tokens
- stable class names for user CSS
- minimal generated CSS
- no dependency on user Tailwind config

## Override model

```ts
import CustomCard from "./components/custom-card.astro";
import Search from "./components/search.tsx";
import { defineComponents } from "blume";

export default defineComponents({
  mdx: {
    Card: CustomCard,
  },
  layout: {
    Search: {
      component: Search,
      client: "load",
    },
  },
});
```

## Source install model

`blume add code-group` should install:

- component source
- any island source
- CSS if needed
- component registration patch
- usage docs or comments only when useful

Source installs should be easy to diff and remove.

## Component quality bar

Before public beta:

- visual tests for default components
- keyboard tests for interactive components
- dark/light coverage
- responsive coverage
- MDX rendering fixtures
- override fixtures
