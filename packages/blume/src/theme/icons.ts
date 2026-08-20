/**
 * Icon resolution backed by the open Iconify Lucide set. Resolution runs at
 * **build time, server-side**, and returns ready-to-inline SVG, so icons stay
 * zero-JS and fully self-contained (no runtime CDN fetch).
 *
 * Because the Iconify set data is large, this module must only be imported from
 * server contexts (`.astro` frontmatter, the CLI). Client scripts use the tiny
 * hand-inlined set in `./chrome-icons.ts` instead.
 */
import { createRequire } from "node:module";

import type { IconifyJSON } from "@iconify/types";
import { getIconData, iconToSVG } from "@iconify/utils";

// Load the icon-set JSON with a CJS `require` rather than an `import ... with
// { type: "json" }`: the bundled Node CLI drops the import attribute (Bun.build
// strips it when externalizing) and then rejects the module, whereas `require`
// of a JSON file needs no attribute and works under both Node and Bun.
const requireJson = createRequire(import.meta.url);
// SAFETY: the required file is the Iconify-published icon-set JSON, whose
// shape is exactly `IconifyJSON`.
const loadSet = (pkg: string): IconifyJSON => requireJson(pkg) as IconifyJSON;

const SETS = {
  lucide: loadSet("@iconify-json/lucide/icons.json"),
};

/** Blume's only icon library. */
const DEFAULT_SET = "lucide";

/** Explicit `prefix:name` prefixes. Lucide is the only bundled set. */
const PREFIX_SETS = {
  lucide: "lucide",
};

/**
 * Own-property map lookup. Icon names come from content and config, so a value
 * like `constructor:x` would otherwise resolve an Object.prototype member (a
 * function) and crash resolution deep in the build with no pointer to the
 * offending page.
 */
const ownEntry = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

export interface ResolvedIcon {
  /** Inner SVG markup (self-styled: carries its own fill/stroke). */
  body: string;
  /** The resolved icon name. */
  name: string;
  /** The icon's viewBox (Lucide is 24×24). */
  viewBox: string;
}

const normalize = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/gu, "-");

const fromSet = (setName: string, iconName: string): ResolvedIcon | null => {
  const set = ownEntry(SETS, setName);
  const data = set && getIconData(set, iconName);
  if (!data) {
    return null;
  }
  const { attributes, body } = iconToSVG(data, { height: "auto" });
  return { body, name: iconName, viewBox: attributes.viewBox };
};

/**
 * Resolve an icon name to inline SVG. Honors an explicit `lucide:name` prefix;
 * a bare name resolves against Lucide.
 */
export const resolveIcon = (name: string): ResolvedIcon | null => {
  const normalized = normalize(name);
  const colon = normalized.indexOf(":");
  if (colon > 0) {
    const setName = ownEntry(PREFIX_SETS, normalized.slice(0, colon));
    return setName ? fromSet(setName, normalized.slice(colon + 1)) : null;
  }
  return fromSet(DEFAULT_SET, normalized);
};

/**
 * Whether a name resolves to a renderable icon. Exactly mirrors
 * {@link resolveIcon}: a laxer check (e.g. matching the bare name under an
 * unknown prefix) would let callers suppress their fallback and diagnostics
 * for a name `<Icon>` then renders as nothing.
 */
export const hasIcon = (name: string): boolean => resolveIcon(name) !== null;
