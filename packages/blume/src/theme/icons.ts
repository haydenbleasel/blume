/**
 * Icon resolution backed by the open Iconify icon sets — Font Awesome (free),
 * Lucide, and Tabler — the three libraries Mintlify exposes. Resolution runs at
 * **build time, server-side**, and returns ready-to-inline SVG, so icons stay
 * zero-JS and fully self-contained (no runtime CDN fetch, unlike Mintlify).
 *
 * Because the Iconify set data is large, this module must only be imported from
 * server contexts (`.astro` frontmatter, the CLI). Client scripts use the tiny
 * hand-inlined set in `./chrome-icons.ts` instead.
 *
 * Coverage vs Mintlify: full parity for every Font Awesome *free* name, Lucide,
 * and Tabler. Font Awesome Pro styles (`light`/`thin`/`duotone`/`sharp-solid`)
 * aren't in the open data, so they fall back to `solid`.
 */
import { createRequire } from "node:module";

import type { IconifyJSON } from "@iconify/types";
import { getIconData, iconToSVG } from "@iconify/utils";

// Load the icon-set JSON with a CJS `require` rather than an `import ... with
// { type: "json" }`: the bundled Node CLI drops the import attribute (Bun.build
// strips it when externalizing) and then rejects the module, whereas `require`
// of a JSON file needs no attribute and works under both Node and Bun.
const requireJson = createRequire(import.meta.url);
const loadSet = (pkg: string): IconifyJSON => requireJson(pkg) as IconifyJSON;

const SETS: Record<string, IconifyJSON> = {
  "fa6-brands": loadSet("@iconify-json/fa6-brands/icons.json"),
  "fa6-regular": loadSet("@iconify-json/fa6-regular/icons.json"),
  "fa6-solid": loadSet("@iconify-json/fa6-solid/icons.json"),
  lucide: loadSet("@iconify-json/lucide/icons.json"),
  tabler: loadSet("@iconify-json/tabler/icons.json"),
};

/** Blume's default library when a project sets no `icons.library`. */
const DEFAULT_SET = "lucide";

/** `icons.library` config value → Iconify set. */
const LIBRARY_SETS: Record<string, string> = {
  fa: "fa6-solid",
  "font-awesome": "fa6-solid",
  fontawesome: "fa6-solid",
  lucide: "lucide",
  tabler: "tabler",
};

/**
 * Mintlify Font Awesome `iconType` → Iconify set. The Pro-only styles
 * (`light`/`thin`/`duotone`/`sharp-solid`) aren't in the free data, so they map
 * to `solid` rather than render nothing.
 */
const ICON_TYPE_SETS: Record<string, string> = {
  brands: "fa6-brands",
  duotone: "fa6-solid",
  light: "fa6-solid",
  regular: "fa6-regular",
  "sharp-solid": "fa6-solid",
  solid: "fa6-solid",
  thin: "fa6-solid",
};

/** Explicit `prefix:name` prefixes (Iconify prefixes + common FA aliases). */
const PREFIX_SETS: Record<string, string> = {
  ...LIBRARY_SETS,
  fa: "fa6-solid",
  "fa-brands": "fa6-brands",
  "fa-regular": "fa6-regular",
  "fa-solid": "fa6-solid",
  "fa6-brands": "fa6-brands",
  "fa6-regular": "fa6-regular",
  "fa6-solid": "fa6-solid",
  fab: "fa6-brands",
  far: "fa6-regular",
  fas: "fa6-solid",
  ti: "tabler",
};

export interface ResolvedIcon {
  /** Inner SVG markup (self-styled: carries its own fill/stroke). */
  body: string;
  /** The resolved icon name. */
  name: string;
  /** The icon's viewBox, which varies per library (24×24, 512-height, …). */
  viewBox: string;
}

export interface ResolveIconOptions {
  /** Font Awesome style selector (`solid`, `regular`, `brands`, …). */
  iconType?: string;
  /** Default library for a bare name (`fontawesome` | `lucide` | `tabler`). */
  library?: string;
}

const normalize = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/gu, "-");

/** Which set a bare name resolves against, given library/iconType hints. */
const setFor = (options: ResolveIconOptions): string => {
  if (options.iconType) {
    const set = ICON_TYPE_SETS[normalize(options.iconType)];
    if (set) {
      return set;
    }
  }
  if (options.library) {
    const set = LIBRARY_SETS[normalize(options.library)];
    if (set) {
      return set;
    }
  }
  return DEFAULT_SET;
};

const fromSet = (setName: string, iconName: string): ResolvedIcon | null => {
  const set = SETS[setName];
  const data = set && getIconData(set, iconName);
  if (!data) {
    return null;
  }
  const { attributes, body } = iconToSVG(data, { height: "auto" });
  return { body, name: iconName, viewBox: attributes.viewBox };
};

// Font Awesome splits brands into their own set, so a bare `github` under a
// solid/regular default still resolves.
const fromFaSet = (setName: string, name: string): ResolvedIcon | null =>
  fromSet(setName, name) ?? fromSet("fa6-brands", name);

const resolveInSet = (setName: string, name: string): ResolvedIcon | null =>
  setName.startsWith("fa6-")
    ? fromFaSet(setName, name)
    : fromSet(setName, name);

/**
 * Resolve an icon name to inline SVG. Honors an explicit `prefix:name`
 * (`lucide:rocket`, `fa6-brands:github`), then `iconType`, then the configured
 * `library`, falling back to Lucide.
 */
export const resolveIcon = (
  name: string,
  options: ResolveIconOptions = {}
): ResolvedIcon | null => {
  const normalized = normalize(name);
  const colon = normalized.indexOf(":");
  if (colon > 0) {
    const setName = PREFIX_SETS[normalized.slice(0, colon)];
    if (setName) {
      return resolveInSet(setName, normalized.slice(colon + 1));
    }
  }
  return resolveInSet(setFor(options), normalized);
};

/**
 * Whether a name resolves to a known icon. Without a library hint this checks
 * every bundled set, so a valid Font Awesome/Tabler name isn't flagged as a typo
 * just because the project's default library is Lucide.
 */
export const hasIcon = (
  name: string,
  options: ResolveIconOptions = {}
): boolean => {
  if (resolveIcon(name, options)) {
    return true;
  }
  const normalized = normalize(name);
  const bare = normalized.includes(":")
    ? normalized.slice(normalized.indexOf(":") + 1)
    : normalized;
  return Object.values(SETS).some((set) => getIconData(set, bare) !== null);
};
