---
"blume": major
---

Component overrides in `components.ts` are planned statically, with no runtime fallback. Every `mdx` and `layout` entry must be an imported identifier, a path string, or a `{ component, client, media }` object literal whose `component` is an imported identifier or a path string. Anything else — an inline function or expression, a component declared in the file itself, a spread, a computed key, a `client` that isn't one of the mode strings — is a `BLUME_COMPONENTS_INVALID` error naming the entry and the accepted forms: `blume dev` reports it in the terminal and the browser overlay, and `blume build` fails. Such overrides used to render without hydration and without any warning.

The `islands` group is gone: an `mdx` entry with a `client` mode is an island, and `defineComponents` no longer accepts an `islands` key. Replace `islands: { Counter }` with `mdx: { Counter: { component: Counter, client: "visible" } }`. The `islands/` folder convention is unchanged and now plans through the same wrappers as `components.ts`, so a `components.ts` `mdx` entry replaces a folder island of the same name. The generated runtime no longer writes `src/generated/islands.ts` or `src/generated/islands/*.astro`; convention islands and hydrated overrides both live under `src/generated/component-slots/`, in `blume eject` output too.
