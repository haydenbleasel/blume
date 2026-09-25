/**
 * The named color each documented Badge `variant` paints with; `accent` is
 * the site's theme accent rather than a fixed hue.
 */
const VARIANT_COLOR = new Map([
  ["accent", "accent"],
  ["danger", "red"],
  ["default", "gray"],
  ["success", "green"],
  ["warning", "orange"],
]);

/**
 * The color a badge renders with: an explicit `color` wins, then the
 * variant's hue. MDX props aren't type-checked, so a variant Badge doesn't
 * know (`info`, which Callout accepts) renders as the default gray badge
 * instead of failing the page build.
 */
export const badgeColorName = (variant: string, color?: string): string =>
  color ?? VARIANT_COLOR.get(variant) ?? "gray";
