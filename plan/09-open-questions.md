# Open questions and decisions

This file tracks decisions after moving Blume to an Astro/Vite-first plan.

## Decided

### Runtime model

Decision: Blume generates and owns a hidden Astro project under `.blume/`.

Rationale:

- preserves zero-boilerplate DX
- makes Astro/Vite an implementation engine rather than the product surface
- allows eject into a normal Astro project
- avoids competing in the Next/Fumadocs lane by default

### Starlight relationship

Decision: Starlight is a reference, not Blume's long-term foundation.

Use Starlight to study:

- content collections
- accessible docs patterns
- Astro integration shape
- plugin ecosystem expectations

Do not build Blume as a Starlight theme unless a prototype needs speed.

### React relationship

Decision: React is first-class for islands, not required for the core theme.

Rationale:

- many docs teams already know React
- AI chat and complex playgrounds benefit from React ecosystem packages
- Astro keeps static pages lightweight
- core components can be Astro-first

### Static default

Decision: `deployment.output` defaults to `static`.

Server mode is opt-in or feature-required.

### Component registry

Decision: follow the source-registry spirit of shadcn, but ship Blume-owned Astro-aware components.

The registry format can be compatible with existing tooling where useful.

### Custom pages

Decision: custom route files are `.astro` in v1.

React/Vue/Svelte/Solid components can be used inside those pages as islands.

### Search baseline

Decision: Pagefind is the likely v1 local search provider.

Keep provider abstraction small so Algolia/Orama/hosted search can follow.

### AI baseline

Decision: AI features should use the AI SDK and Vercel AI Gateway model strings by default.

No provider-specific SDK package should be required for the default path.

## Open technical questions

### Config loader

Options:

- `tsx`
- `jiti`
- Vite SSR loading
- custom ESM loader

Criteria:

- fast
- works in monorepos
- preserves good stack traces
- handles TypeScript configs
- minimizes arbitrary execution

### MDX compiler ownership

Question: how much should Blume use Astro's MDX integration directly vs owning a compile layer that emits Astro-compatible modules?

Preferred direction:

- use Astro/Vite module pipeline for rendering
- own docs-specific transforms, component mapping, metadata extraction, and diagnostics

### Astro content collections

Question: should Blume represent docs as Astro content collections, virtual modules, or an independent graph mounted into Astro?

Preferred direction:

- Blume owns the graph
- generated Astro modules expose the graph to pages/layouts
- use Astro content APIs only where they reduce complexity without constraining product behavior

### Component type model

Question: what is the cleanest public type for components that may be `.astro`, React, or future framework components?

Possible API:

```ts
type ComponentOverride =
  | ComponentReference
  | {
      component: ComponentReference;
      client?: "load" | "idle" | "visible" | "media" | "only";
    };
```

Need type experiments before locking.

### Hydration diagnostics

Question: can Blume reliably detect when a component needs client hydration?

Likely answer:

- detect obvious React island descriptors
- document explicit hydration
- provide friendly runtime diagnostics when browser APIs fail server render

### Dynamic OG

Question: should dynamic OG be server-only or should Blume also support prerendered OG images?

Likely shape:

- static builds can prerender default OG images for known routes
- server builds can generate dynamic OG images through an Astro endpoint
- Vercel can use `@vercel/og` or Satori

### Vercel adapter defaults

Question: when `adapter: "vercel"` is selected, what Vercel services should Blume wire automatically?

Candidates:

- Analytics
- Speed Insights
- Blob for uploads/feedback artifacts
- Edge Config for lightweight runtime config
- OG image endpoint defaults

Keep auto-wiring conservative.

### Registry install locations

Question: where should `blume add` put source files?

Possible default:

```txt
components/blume/
theme.css
components.ts
```

Need avoid polluting user projects while keeping imports readable.

### Eject contract

Question: is eject one-way?

Preferred answer:

- yes, source ownership transfers to the user
- the `blume` package remains the dependency
- CLI should not overwrite ejected files

### API reference engine

Question: should OpenAPI rendering be built in or a separate integration package?

Preferred direction:

- core schemas and components in Blume
- heavy parsers/importers in an internal module or optional integration loaded by `blume`

### Internationalization

Question: v1 or later?

Likely later, but route graph should not block locale prefixes.

### Authenticated docs

Question: should Blume provide auth integrations or just hooks?

Likely later:

- server mode only
- adapter-aware middleware
- Vercel-friendly examples
- no auth provider baked into core

## Risks

### Astro component typing can feel unfamiliar

React users may expect all component overrides to be React components. Blume needs excellent examples that show when to use `.astro` and when to use a React island.

### Generated project debugging

Hidden generated projects can be confusing when errors point into `.blume/`.

Mitigation:

- source maps
- path remapping
- concise diagnostics
- `blume doctor`
- `blume inspect`

### Server/static boundary

Users may enable AI or auth and expect static output.

Mitigation:

- feature capability matrix
- build-time errors
- automatic suggestions
- docs examples

### Product overlap

Astro users may compare Blume with Starlight; Next users may compare it with Fumadocs.

Mitigation:

- clear positioning
- stronger default product layer
- migration tools
- source-level customization
