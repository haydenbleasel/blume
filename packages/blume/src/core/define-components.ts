import type { HydrationMode } from "./schema.ts";

/**
 * A reference to a component. Either an imported component (preferred, for type
 * safety) or a string path resolved relative to the project root.
 */
// oxlint-disable-next-line anti-slop/no-unknown-type-aliases -- deliberately untyped: user configs pass imported components from any framework (React functions, Svelte classes, Vue SFC objects), which share no structural type
export type ComponentReference = unknown | string;

/** An interactive component plus its hydration strategy. */
export interface IslandDescriptor {
  component: ComponentReference;
  client: HydrationMode;
  /** Required when `client` is `"media"`. */
  media?: string;
}

/** A component override: a static component or a hydrated island. */
// oxlint-disable-next-line anti-slop/no-unknown-type-aliases -- inherits the untyped `ComponentReference` above
export type ComponentOverride = ComponentReference | IslandDescriptor;

/**
 * User-authored component overrides, grouped by surface. Blume reads this file
 * statically (never executing it), so every entry must be an imported
 * identifier, a path string, or a `{ component, client, media }` object literal
 * — an entry with a `client` mode is an island, hydrated through a generated
 * wrapper.
 */
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- `ComponentOverride` is untyped by
// design: user configs pass imported components from any framework (React
// functions, Svelte classes, Vue SFC objects), which share no structural type.
// `resolveSlot` and the generated components map are the runtime boundary.
export interface ComponentOverrides {
  /** Layout slot overrides (`Header`, `Sidebar`, `Footer`, ...). */
  layout?: Record<string, ComponentOverride>;
  /**
   * MDX component map overrides (`Callout`, `Card`, ...) and additions,
   * available in every `.mdx` page. Give an entry a `client` mode to hydrate
   * it — the config-file equivalent of dropping a component in `islands/`.
   */
  mdx?: Record<string, ComponentOverride>;
}
// oxlint-enable anti-slop/no-unsafe-dictionary-type

/**
 * Identity helper for authoring `components.ts`. Provides type inference and a
 * stable home for future normalization; it does not transform input.
 */
export const defineComponents = (
  overrides: ComponentOverrides
): ComponentOverrides => overrides;
