import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  buildThemeCss,
  resolveAccent,
  resolveRadius,
} from "../src/theme/palette.ts";

const themeOf = (over: Record<string, unknown>) =>
  blumeConfigSchema.parse({ theme: over }).theme;

describe("resolveAccent", () => {
  it("maps a named accent preset to its OKLCH value", () => {
    expect(resolveAccent(themeOf({ accent: "purple" }))).toBe(
      "oklch(0.58 0.2 290)"
    );
  });

  it("passes an unknown accent through as a raw CSS color", () => {
    expect(resolveAccent(themeOf({ accent: "#ff0000" }))).toBe("#ff0000");
  });
});

describe("resolveRadius", () => {
  it("maps each radius preset to a CSS length", () => {
    expect(resolveRadius(themeOf({ radius: "none" }))).toBe("0");
    expect(resolveRadius(themeOf({ radius: "sm" }))).toBe("0.25rem");
    expect(resolveRadius(themeOf({ radius: "md" }))).toBe("0.5rem");
    expect(resolveRadius(themeOf({ radius: "lg" }))).toBe("0.75rem");
  });
});

describe("buildThemeCss", () => {
  it("emits accent and radius custom properties on :root", () => {
    const css = buildThemeCss(themeOf({ accent: "teal", radius: "lg" }));
    expect(css).toContain(":root {");
    expect(css).toContain("--blume-accent: oklch(0.6 0.12 195);");
    expect(css).toContain("--blume-radius: 0.75rem;");
  });
});
