import type { ComponentOverride } from "../../core/define-components.ts";

/**
 * Resolve a layout-slot override to the component Astro should render, falling
 * back to Blume's built-in when no usable override is configured.
 *
 * An override may be a bare component reference or an `IslandDescriptor`
 * (`{ component, client }`); only the component is used here. String-path
 * overrides can't be imported at render time, so they fall back to the built-in
 * for now (imported components are the recommended, type-safe form).
 */
export const resolveSlot = <T>(
  override: ComponentOverride | undefined,
  fallback: T
): T => {
  if (
    override === undefined ||
    override === null ||
    typeof override === "string"
  ) {
    return fallback;
  }
  if (
    typeof override === "object" &&
    "component" in override &&
    override.component !== undefined &&
    override.component !== null
  ) {
    return override.component as T;
  }
  return override as T;
};
