# Customization

## Goal

Blume should start with no app code and scale toward full ownership.

Customization ladder:

1. config
2. frontmatter and meta files
3. CSS tokens
4. component overrides
5. custom pages
6. registry-installed source
7. eject to Astro

## Theme CSS

Users can add:

```txt
theme.css
```

Example:

```css
:root {
  --blume-accent: oklch(0.68 0.14 180);
  --blume-radius: 0.5rem;
}
```

The generated Astro project imports this after Blume defaults.

## Component overrides

Default file:

```txt
components.ts
```

Example:

```ts
import CustomCallout from "./components/custom-callout.astro";
import AskButton from "./components/ask-button.tsx";
import { defineComponents } from "blume";

export default defineComponents({
  mdx: {
    Callout: CustomCallout,
  },
  islands: {
    AskButton: {
      component: AskButton,
      client: "load",
    },
  },
});
```

The API should allow:

- `.astro` components for static/server-rendered UI
- React components for interactive islands
- future Vue/Svelte/Solid islands through Astro integrations
- slot-specific overrides for layout areas
- MDX component overrides

## Hydration model

Astro components render on the server by default.

Interactive components must be explicit islands:

- `client:load`
- `client:idle`
- `client:visible`
- `client:media`
- `client:only`

Blume's `defineComponents` can express this as structured metadata so users do not need to write generated `.astro` wrappers by hand.

If an override needs browser APIs but no hydration mode is configured, Blume should show a friendly diagnostic.

## Layout slots

Common slots:

- `Layout`
- `Header`
- `Sidebar`
- `MobileNav`
- `Search`
- `TableOfContents`
- `Footer`
- `PageHeader`
- `PageFooter`
- `Pagination`

Override example:

```ts
export default defineComponents({
  layout: {
    Header: "./components/header.astro",
  },
});
```

String paths can be convenient in config, but imported components should be preferred for type safety.

## Custom pages

Custom pages live in:

```txt
pages/
  changelog.astro
  examples/[slug].astro
```

They are copied or virtually mounted into the generated Astro runtime.

Custom pages should receive access to Blume data:

- project config
- nav tree
- search config
- theme tokens
- route helpers
- page collections

In `.astro` files, this should feel like:

```astro
---
import { getBlumeCollection } from "blume/runtime";

const changelog = await getBlumeCollection("changelog");
---

<BlumePage title="Changelog">
  {changelog.map((entry) => <article>{entry.title}</article>)}
</BlumePage>
```

Exact helper names can change, but the contract should be Astro-native.

## React islands

React should be first-class for interactive docs UI:

- Ask AI
- feedback widget
- command menu
- playgrounds
- API explorers
- code sandboxes

Blume should install or enable `@astrojs/react` when a React island is used.

React helpers can include:

- `useBlume()`
- `usePage()`
- `useSearch()`
- `useAskAI()`

These are island helpers, not the core rendering model.

## Registry customization

`blume add` should install source files into the user project.

Example:

```bash
blume add feedback
```

Possible output:

```txt
components/
  feedback-widget.tsx
  feedback-widget.css
components.ts
```

The registry format can be shadcn-compatible where useful, but the components should be Blume-owned and Astro-aware.

## Eject

`blume eject` promotes the hidden Astro runtime into user-owned source.

Use eject for:

- full layout rewrites
- unusual routing
- deep adapter customization
- custom Vite plugins
- app-like docs portals

Eject should preserve content and keep the `blume` package importable.
