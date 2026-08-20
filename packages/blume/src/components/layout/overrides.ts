import type {
  ComponentOverride,
  IslandDescriptor,
} from "../../core/define-components.ts";

/** A leftover path string an override resolved to (see `resolveSlot`). */
const isPathString = (override: ComponentOverride): override is string =>
  typeof override === "string";

/** An `IslandDescriptor` whose `component` is actually present. */
const isResolvedIsland = (
  override: ComponentOverride
): override is IslandDescriptor =>
  typeof override === "object" &&
  override !== null &&
  "component" in override &&
  override.component !== undefined &&
  override.component !== null;

/**
 * Resolve a layout-slot override to the component Astro should render, falling
 * back to Blume's built-in when no usable override is configured.
 *
 * By the time values reach here, the generated `components.ts` has already turned
 * path strings and hydrated (`client:*`) overrides into imported components /
 * wrappers, so the runtime map holds real components. This handles the remaining
 * cases: a bare component reference, an `IslandDescriptor` (`{ component }`,
 * unwrapped to its component), and — as a safety net for overrides that couldn't
 * be resolved at build time — a leftover string, which falls back to the built-in.
 */
export const resolveSlot = <T>(
  override: ComponentOverride | undefined,
  fallback: T
): T => {
  if (override === undefined || override === null || isPathString(override)) {
    return fallback;
  }
  if (isResolvedIsland(override)) {
    // SAFETY: `ComponentReference` is untyped (`unknown`); the generated
    // components map stores real components for this slot, so the descriptor's
    // component is renderable as the slot's component type.
    return override.component as T;
  }
  // SAFETY: same untyped `ComponentReference` — a bare value here is the
  // imported component the config referenced for this slot.
  return override as T;
};
