import type { JsonValue } from "../core/adapter.ts";

/**
 * JSON for an inline `<script>` body. `JSON.stringify` leaves `<` alone, so a
 * value like `</script>` would end the script element early; escape it the way
 * the layouts do for their JSON.
 */
export const inlineJson = (value: JsonValue): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

/**
 * A snippet that re-sends a pageview on every client-router navigation, for a
 * provider whose loader only counts real page loads. Keyed off
 * `astro:page-load` with a path-plus-query guard held in `window[slot]`, so the
 * initial load (which the loader already counted) and same-page hash moves
 * aren't double-counted, while a query-only navigation (`?tab=a` → `?tab=b`)
 * still is. Each adapter passes its own slot: two adapters sharing one would
 * see the second always match the first's update and never fire.
 */
export const spaPageviews = (slot: string, capture: string): string =>
  `document.addEventListener("astro:page-load",function(){var p=window.${slot},c=location.pathname+location.search;window.${slot}=c;if(p!==undefined&&p!==c){${capture}}});`;
