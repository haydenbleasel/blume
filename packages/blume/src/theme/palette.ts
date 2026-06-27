import type { ResolvedConfig } from "../core/schema.ts";

/** Named accent presets mapped to OKLCH values. */
const ACCENTS: Record<string, string> = {
  blue: "oklch(0.62 0.16 250)",
  green: "oklch(0.6 0.16 150)",
  orange: "oklch(0.68 0.17 50)",
  pink: "oklch(0.65 0.2 350)",
  purple: "oklch(0.58 0.2 290)",
  red: "oklch(0.58 0.22 25)",
  teal: "oklch(0.6 0.12 195)",
};

const RADII: Record<ResolvedConfig["theme"]["radius"], string> = {
  lg: "0.75rem",
  md: "0.5rem",
  none: "0",
  sm: "0.25rem",
};

const SYSTEM_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

type FontConfig = NonNullable<ResolvedConfig["theme"]["fonts"]["body"]>;
type ThemeFonts = ResolvedConfig["theme"]["fonts"];

const cssString = (value: string): string => JSON.stringify(value);

const fontStack = (family: string): string =>
  `${cssString(family)}, ${SYSTEM_SANS}`;

const mergedFont = (fonts: ThemeFonts, override?: FontConfig): FontConfig => ({
  family: override?.family ?? fonts.family,
  format: override?.format ?? fonts.format,
  source: override?.source ?? fonts.source,
  weight: override?.weight ?? fonts.weight,
});

const fontFaceKey = (font: FontConfig): string =>
  `${font.family ?? ""}\u0000${font.source ?? ""}`;

const fontFaceCss = (font: FontConfig): string | undefined => {
  if (!font.family || !font.source) {
    return undefined;
  }
  const format = font.format ? ` format("${font.format}")` : "";
  const weight =
    typeof font.weight === "number" ? `\n  font-weight: ${font.weight};` : "";
  return `@font-face {
  font-family: ${cssString(font.family)};
  src: url(${cssString(font.source)})${format};${weight}
  font-display: swap;
}`;
};

const fontFacesCss = (fonts: ThemeFonts): string => {
  const seen = new Set<string>();
  return [
    mergedFont(fonts),
    mergedFont(fonts, fonts.body),
    mergedFont(fonts, fonts.heading),
  ]
    .flatMap((font) => {
      const key = fontFaceKey(font);
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      const css = fontFaceCss(font);
      return css ? [css] : [];
    })
    .join("\n");
};

const fontTokenCss = (fonts: ThemeFonts): string => {
  const body = mergedFont(fonts, fonts.body);
  const heading = mergedFont(fonts, fonts.heading);
  return [
    body.family ? `  --blume-font-body: ${fontStack(body.family)};` : null,
    heading.family
      ? `  --blume-font-heading: ${fontStack(heading.family)};`
      : null,
    typeof body.weight === "number"
      ? `  --blume-font-body-weight: ${body.weight};`
      : null,
    typeof heading.weight === "number"
      ? `  --blume-font-heading-weight: ${heading.weight};`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
};

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
    fontTokens: string;
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
    ...cssToken("--blume-background", theme.background),
    ...cssToken(
      "--blume-background-image",
      theme.backgroundImage ? backgroundImageCss(theme.backgroundImage) : null
    ),
    options.backgroundDecoration.trimEnd(),
    `  --blume-radius: ${options.radius};`,
    options.fontTokens,
  ]
    .filter(Boolean)
    .join("\n");

const themeDarkCss = (
  theme: ResolvedConfig["theme"],
  accentDark: string | null
): string => {
  const tokens = [
    ...cssToken("--blume-accent", accentDark),
    ...cssToken("--blume-background", theme.backgroundDark),
    ...cssToken(
      "--blume-background-image",
      theme.backgroundImageDark
        ? backgroundImageCss(theme.backgroundImageDark)
        : null
    ),
  ];
  if (tokens.length === 0) {
    return "";
  }
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
  ACCENTS[theme.accent] ?? theme.accent;

/** Resolve the configured radius preset to a CSS length. */
export const resolveRadius = (theme: ResolvedConfig["theme"]): string =>
  RADII[theme.radius];

/**
 * Compile theme config into CSS custom properties. A named accent resolves to
 * its preset; any other value is treated as a raw CSS color so users can pass
 * arbitrary colors without a config change.
 */
export const buildThemeCss = (theme: ResolvedConfig["theme"]): string => {
  const accent = ACCENTS[theme.accent] ?? theme.accent;
  const accentDark = theme.accentDark
    ? (ACCENTS[theme.accentDark] ?? theme.accentDark)
    : null;
  const action = theme.action ? (ACCENTS[theme.action] ?? theme.action) : null;
  const backgroundDecoration = backgroundDecorationCss(
    theme.backgroundDecoration
  );
  const fontFaces = fontFacesCss(theme.fonts);
  const fontTokens = fontTokenCss(theme.fonts);
  const radius = RADII[theme.radius];
  const root = themeRootCss(theme, {
    accent,
    action,
    backgroundDecoration,
    fontTokens,
    radius,
  });
  const dark = themeDarkCss(theme, accentDark);

  return `/* Generated by Blume from theme config. */
${fontFaces ? `${fontFaces}\n` : ""}:root {
${root}
}
${dark}`;
};
