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

/** User-authored component overrides, grouped by surface. */
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- `ComponentOverride` is untyped by
// design: user configs pass imported components from any framework (React
// functions, Svelte classes, Vue SFC objects), which share no structural type.
// `resolveSlot` and the generated components map are the runtime boundary.
export interface ComponentOverrides {
  /**
   * Interactive framework components made available in every `.mdx` page. Like
   * `mdx`, but hydrated: entries default to `client: "visible"`. Shorthand for
   * an `mdx` descriptor with a client mode, and the config-file equivalent of
   * dropping a component in the `islands/` folder.
   */
  islands?: Record<string, ComponentOverride>;
  /** Layout slot overrides (`Header`, `Sidebar`, `Footer`, ...). */
  layout?: Record<string, ComponentOverride>;
  /** MDX component map overrides (`Callout`, `Card`, ...). */
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
