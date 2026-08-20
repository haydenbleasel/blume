import type { ResolvedConfig } from "../core/schema.ts";

const FALLBACK_ACCENT = "oklch(0.62 0.16 250)";

/**
 * Named accent presets mapped to OKLCH values. The single source of truth for
 * preset colors: the theme CSS and the OG card (og/card.ts) both resolve from
 * this table, so a site and its social cards can't disagree about "blue".
 */
export const ACCENTS = {
  blue: FALLBACK_ACCENT,
  green: "oklch(0.6 0.16 150)",
  orange: "oklch(0.68 0.17 50)",
  pink: "oklch(0.65 0.2 350)",
  purple: "oklch(0.58 0.2 290)",
  red: "oklch(0.58 0.22 25)",
  teal: "oklch(0.6 0.12 195)",
} satisfies Record<string, string>;

/**
 * Whether a raw config value names an accent preset. `hasOwn` keeps a value
 * like "constructor" from resolving an Object.prototype member — which would
 * stringify a function into the generated CSS, breaking the rule (the exact
 * breakout {@link safeColor} exists to prevent).
 */
export const isAccentPreset = (value: string): value is keyof typeof ACCENTS =>
  Object.hasOwn(ACCENTS, value);

// Characters valid in a CSS color value (hex, rgb/hsl/oklch functions, named
// colors). Anything else — notably `;`, `{`, `}` — could break out of the
// declaration and inject rules, so such a value is rejected.
const CSS_COLOR = /^[\w\s#%.,()/+-]+$/u;

/** Pass a raw color through only if it can't break out of a CSS declaration. */
const safeColor = (value: string, fallback: string): string =>
  CSS_COLOR.test(value.trim()) ? value.trim() : fallback;

/** Resolve a named preset or fall back to {@link safeColor}. */
const presetOrColor = (value: string): string =>
  isAccentPreset(value) ? ACCENTS[value] : safeColor(value, FALLBACK_ACCENT);

/** Like {@link safeColor} but drops an unsafe/absent value to `null`. */
const safeColorOrNull = (value: string | undefined): string | null =>
  value && CSS_COLOR.test(value.trim()) ? value.trim() : null;

const RADII = {
  lg: "0.75rem",
  md: "0.5rem",
  none: "0",
  sm: "0.25rem",
} satisfies Record<ResolvedConfig["theme"]["radius"], string>;

const cssString = (value: string): string => JSON.stringify(value);

const backgroundImageCss = (image: string): string =>
  `url(${cssString(image)})`;

const cssToken = (name: string, value?: string | null): string[] =>
  value ? [`  ${name}: ${value};`] : [];

const themeRootCss = (
  theme: ResolvedConfig["theme"],
  options: {
    accent: string;
    action: string | null;
    radius: string;
  }
): string =>
  [
    `  --blume-accent: ${options.accent};`,
    ...cssToken("--blume-action", options.action),
    ...cssToken(
      "--blume-action-foreground",
      options.action ? "oklch(1 0 0)" : null
    ),
    ...cssToken("--blume-background", safeColorOrNull(theme.background?.light)),
    ...cssToken(
      "--blume-background-image",
      theme.backgroundImage?.light
        ? backgroundImageCss(theme.backgroundImage.light)
        : null
    ),
    `  --blume-radius: ${options.radius};`,
  ]
    .filter(Boolean)
    .join("\n");

const themeDarkCss = (
  theme: ResolvedConfig["theme"],
  options: {
    accent: string;
    action: string | null;
  }
): string => {
  // Mode-shared tokens (accent, action) must be re-declared here: the base
  // stylesheet's own `:root[data-theme="dark"]` block outranks the `:root`
  // config tokens on specificity, so without this block dark mode would
  // silently keep its neutral defaults and ignore the config.
  const tokens = [
    `  --blume-accent: ${options.accent};`,
    "  --blume-accent-foreground: oklch(1 0 0);",
    ...cssToken("--blume-action", options.action),
    ...cssToken(
      "--blume-action-foreground",
      options.action ? "oklch(1 0 0)" : null
    ),
    ...cssToken("--blume-background", safeColorOrNull(theme.background?.dark)),
    ...cssToken(
      "--blume-background-image",
      theme.backgroundImage?.dark
        ? backgroundImageCss(theme.backgroundImage.dark)
        : null
    ),
  ].filter(Boolean);
  return `:root[data-theme="dark"] {
${tokens.join("\n")}
}
`;
};

/** Per-mode accent CSS colors. */
export interface AccentColors {
  dark: string;
  light: string;
}

/**
 * Resolve the configured accent to per-mode CSS colors. A named accent
 * resolves to its preset; any other value is treated as a raw CSS color so
 * users can pass arbitrary colors without a config change. A string accent
 * has already been normalized by the config schema to the same color for
 * both modes.
 */
export const resolveAccent = (
  theme: ResolvedConfig["theme"]
): AccentColors => ({
  dark: presetOrColor(theme.accent.dark),
  light: presetOrColor(theme.accent.light),
});

/** Resolve the configured radius preset to a CSS length. */
export const resolveRadius = (theme: ResolvedConfig["theme"]): string =>
  RADII[theme.radius];

/**
 * Compile theme config into CSS custom properties. A named accent resolves to
 * its preset; any other value is treated as a raw CSS color so users can pass
 * arbitrary colors without a config change.
 */
export const buildThemeCss = (theme: ResolvedConfig["theme"]): string => {
  const accent = resolveAccent(theme);
  const action = theme.action ? presetOrColor(theme.action) : null;
  const radius = RADII[theme.radius];
  const root = themeRootCss(theme, {
    accent: accent.light,
    action,
    radius,
  });
  const dark = themeDarkCss(theme, {
    accent: accent.dark,
    action,
  });

  return `/* Generated by Blume from theme config. */
:root {
${root}
}
${dark}`;
};
