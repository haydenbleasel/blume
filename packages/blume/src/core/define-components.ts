import type { HydrationMode } from "./schema.ts";

/**
 * A reference to a component. Either an imported component (preferred, for type
 * safety) or a string path resolved relative to the project root.
 */
export type ComponentReference = unknown | string;

/** An interactive component plus its hydration strategy. */
export interface IslandDescriptor {
  component: ComponentReference;
  client: HydrationMode;
  /** Required when `client` is `"media"`. */
  media?: string;
}

/** A component override: a static component or a hydrated island. */
export type ComponentOverride = ComponentReference | IslandDescriptor;

/** User-authored component overrides, grouped by surface. */
export interface ComponentOverrides {
  /** MDX component map overrides (`Callout`, `Card`, ...). */
  mdx?: Record<string, ComponentOverride>;
  /** Layout slot overrides (`Header`, `Sidebar`, `Search`, ...). */
  layout?: Record<string, ComponentOverride>;
}

/**
 * Identity helper for authoring `components.ts`. Provides type inference and a
 * stable home for future normalization; it does not transform input.
 */
export const defineComponents = (
  overrides: ComponentOverrides
): ComponentOverrides => overrides;
