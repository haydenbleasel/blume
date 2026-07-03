import type { ResolvedConfig } from "../core/schema.ts";

const FALLBACK_ACCENT = "oklch(0.62 0.16 250)";

/** Named accent presets mapped to OKLCH values. */
const ACCENTS: Record<string, string> = {
  blue: FALLBACK_ACCENT,
  green: "oklch(0.6 0.16 150)",
  orange: "oklch(0.68 0.17 50)",
  pink: "oklch(0.65 0.2 350)",
  purple: "oklch(0.58 0.2 290)",
  red: "oklch(0.58 0.22 25)",
  teal: "oklch(0.6 0.12 195)",
};

// Characters valid in a CSS color value (hex, rgb/hsl/oklch functions, named
// colors). Anything else — notably `;`, `{`, `}` — could break out of the
// declaration and inject rules, so such a value is rejected.
const CSS_COLOR = /^[\w\s#%.,()/+-]+$/u;

/** Pass a raw color through only if it can't break out of a CSS declaration. */
const safeColor = (value: string, fallback: string): string =>
  CSS_COLOR.test(value.trim()) ? value.trim() : fallback;

/**
 * Resolve a named preset or fall back to {@link safeColor}. `hasOwn` keeps a
 * value like "constructor" from resolving an Object.prototype member — which
 * would stringify a function into the generated CSS, breaking the rule (the
 * exact breakout safeColor exists to prevent).
 */
const presetOrColor = (value: string): string =>
  Object.hasOwn(ACCENTS, value)
    ? (ACCENTS[value] as string)
    : safeColor(value, FALLBACK_ACCENT);

/** Like {@link safeColor} but drops an unsafe/absent value to `null`. */
const safeColorOrNull = (value: string | undefined): string | null =>
  value && CSS_COLOR.test(value.trim()) ? value.trim() : null;

const RADII: Record<ResolvedConfig["theme"]["radius"], string> = {
  lg: "0.75rem",
  md: "0.5rem",
  none: "0",
  sm: "0.25rem",
};

const cssString = (value: string): string => JSON.stringify(value);

const backgroundImageCss = (image: string): string =>
  `url(${cssString(image)})`;

const cssToken = (name: string, value?: string | null): string[] =>
  value ? [`  ${name}: ${value};`] : [];

const backgroundDecorationCss = (
  decoration: ResolvedConfig["theme"]["backgroundDecoration"]
): string => {
  if (decoration === "gradient") {
    return `  --blume-background-decoration: radial-gradient(circle at top left, color-mix(in oklab, var(--blume-accent) 18%, transparent), transparent 28rem), radial-gradient(circle at top right, color-mix(in oklab, var(--blume-action) 12%, transparent), transparent 24rem);
  --blume-background-decoration-repeat: no-repeat, no-repeat;
  --blume-background-decoration-size: auto, auto;
`;
  }
  if (decoration === "grid") {
    return `  --blume-background-decoration: linear-gradient(var(--blume-border) 1px, transparent 1px), linear-gradient(90deg, var(--blume-border) 1px, transparent 1px);
  --blume-background-decoration-repeat: repeat, repeat;
  --blume-background-decoration-size: 2rem 2rem, 2rem 2rem;
`;
  }
  if (decoration === "windows") {
    return `  --blume-background-decoration: linear-gradient(90deg, color-mix(in oklab, var(--blume-border) 70%, transparent) 1px, transparent 1px), linear-gradient(var(--blume-border) 1px, transparent 1px);
  --blume-background-decoration-repeat: repeat, repeat;
  --blume-background-decoration-size: 7rem 4.5rem, 7rem 4.5rem;
`;
  }
  return "";
};

const themeRootCss = (
  theme: ResolvedConfig["theme"],
  options: {
    accent: string;
    action: string | null;
    backgroundDecoration: string;
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
    ...cssToken("--blume-background", safeColorOrNull(theme.background)),
    ...cssToken(
      "--blume-background-image",
      theme.backgroundImage ? backgroundImageCss(theme.backgroundImage) : null
    ),
    options.backgroundDecoration.trimEnd(),
    `  --blume-radius: ${options.radius};`,
  ]
    .filter(Boolean)
    .join("\n");

const themeDarkCss = (
  theme: ResolvedConfig["theme"],
  options: {
    accent: string;
    action: string | null;
    backgroundDecoration: string;
  }
): string => {
  // Mode-shared tokens (accent, action, decoration) must be re-declared here:
  // the base stylesheet's own `:root[data-theme="dark"]` block outranks the
  // `:root` config tokens on specificity, so without this block dark mode
  // would silently keep its neutral defaults and ignore the config.
  const tokens = [
    `  --blume-accent: ${options.accent};`,
    "  --blume-accent-foreground: oklch(1 0 0);",
    ...cssToken("--blume-action", options.action),
    ...cssToken(
      "--blume-action-foreground",
      options.action ? "oklch(1 0 0)" : null
    ),
    ...cssToken("--blume-background", safeColorOrNull(theme.backgroundDark)),
    ...cssToken(
      "--blume-background-image",
      theme.backgroundImageDark
        ? backgroundImageCss(theme.backgroundImageDark)
        : null
    ),
    options.backgroundDecoration.trimEnd(),
  ].filter(Boolean);
  return `:root[data-theme="dark"] {
${tokens.join("\n")}
}
`;
};

/**
 * Resolve the configured accent to a CSS color. A named accent resolves to its
 * preset; any other value is treated as a raw CSS color so users can pass
 * arbitrary colors without a config change.
 */
export const resolveAccent = (theme: ResolvedConfig["theme"]): string =>
  presetOrColor(theme.accent);

/** Resolve the configured radius preset to a CSS length. */
export const resolveRadius = (theme: ResolvedConfig["theme"]): string =>
  RADII[theme.radius];

/**
 * Compile theme config into CSS custom properties. A named accent resolves to
 * its preset; any other value is treated as a raw CSS color so users can pass
 * arbitrary colors without a config change.
 */
export const buildThemeCss = (theme: ResolvedConfig["theme"]): string => {
  const accent = presetOrColor(theme.accent);
  const accentDark = theme.accentDark ? presetOrColor(theme.accentDark) : null;
  const action = theme.action ? presetOrColor(theme.action) : null;
  const backgroundDecoration = backgroundDecorationCss(
    theme.backgroundDecoration
  );
  const radius = RADII[theme.radius];
  const root = themeRootCss(theme, {
    accent,
    action,
    backgroundDecoration,
    radius,
  });
  const dark = themeDarkCss(theme, {
    accent: accentDark ?? accent,
    action,
    backgroundDecoration,
  });

  return `/* Generated by Blume from theme config. */
:root {
${root}
}
${dark}`;
};
