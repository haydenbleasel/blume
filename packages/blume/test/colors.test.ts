import { describe, expect, it } from "bun:test";

import {
  ADMONITION_ICON,
  ADMONITION_ICON_CLASS,
  admonitionType,
  DEPRECATED_LABEL_CLASS,
  METHOD_COLORS,
  MUTED,
  methodColor,
  STROKE,
  statusColor,
  TINT,
} from "../src/components/colors.ts";

/** The light-mode `text-<hue>-<step>` utility in a class string. */
const lightStep = (classes: string, hue: string): number => {
  const match = classes.match(new RegExp(`(?:^| )text-${hue}-(\\d+)`, "u"));
  if (!match) {
    throw new Error(`no light text step for ${hue} in "${classes}"`);
  }
  return Number(match[1]);
};

describe("tinted label colors", () => {
  // Green and orange fall under 4.5:1 at `-700` over a 15% tint of their own
  // hue (and green under it on the muted surface for a stroke badge), so both
  // tables hold them at `-800`. Yellow already needs `-800` over its 20% tint.
  it.each(["green", "orange", "yellow"] as const)(
    "%s takes -800 in light mode, filled and stroked",
    (hue) => {
      expect(lightStep(TINT[hue], hue)).toBe(800);
      expect(lightStep(STROKE[hue], hue)).toBe(800);
    }
  );

  it.each(["blue", "purple", "red", "teal", "violet"] as const)(
    "%s takes -700 in light mode, filled and stroked",
    (hue) => {
      expect(lightStep(TINT[hue], hue)).toBe(700);
      expect(lightStep(STROKE[hue], hue)).toBe(700);
    }
  );

  it("every hue lightens to -300 in dark mode", () => {
    for (const [hue, classes] of Object.entries({ ...TINT, ...STROKE })) {
      expect(classes).toContain(`dark:text-${hue}-300`);
    }
  });

  it("pairs each filled label with a tint of its own hue", () => {
    for (const [hue, classes] of Object.entries(TINT)) {
      expect(classes).toMatch(new RegExp(`^bg-${hue}-500/\\d+ `, "u"));
    }
    for (const [hue, classes] of Object.entries(STROKE)) {
      expect(classes).toMatch(new RegExp(`^border-${hue}-500/\\d+ `, "u"));
    }
  });
});

describe("methodColor", () => {
  it("maps HTTP methods, AsyncAPI actions, and GraphQL kinds to hue tints", () => {
    expect(methodColor("GET")).toBe(TINT.green);
    expect(methodColor("PUT")).toBe(TINT.orange);
    expect(methodColor("QUERY")).toBe(TINT.green);
    expect(methodColor("SEND")).toBe(TINT.violet);
    expect(methodColor("RECEIVE")).toBe(TINT.teal);
    expect(methodColor("HEAD")).toBe(MUTED);
  });

  it("is case-insensitive and falls through to muted", () => {
    expect(methodColor("delete")).toBe(TINT.red);
    expect(methodColor("TRACE")).toBe(MUTED);
    expect(methodColor("Object")).toBe(MUTED);
  });

  it("only ever hands out entries from the shared tables", () => {
    const allowed = new Set([...Object.values(TINT), MUTED]);
    for (const classes of Object.values(METHOD_COLORS)) {
      expect(allowed.has(classes)).toBe(true);
    }
  });
});

describe("statusColor", () => {
  it("colors by status class and falls through to muted", () => {
    expect(statusColor("200")).toBe(TINT.green);
    expect(statusColor("301")).toBe(TINT.blue);
    expect(statusColor("404")).toBe(TINT.orange);
    expect(statusColor("500")).toBe(TINT.red);
    expect(statusColor("default")).toBe(MUTED);
    expect(statusColor("1XX")).toBe(MUTED);
  });
});

describe("deprecated label", () => {
  it("draws orange at -700 on the page background", () => {
    expect(lightStep(DEPRECATED_LABEL_CLASS, "orange")).toBe(700);
    expect(DEPRECATED_LABEL_CLASS).toContain("dark:text-orange-400");
  });
});

describe("admonitions", () => {
  it("folds the check alias into success", () => {
    expect(admonitionType("check")).toBe("success");
    expect(admonitionType("warning")).toBe("warning");
  });

  it("icons meet the 3:1 non-text bar over their tint", () => {
    expect(lightStep(ADMONITION_ICON_CLASS.success, "green")).toBe(700);
    expect(lightStep(ADMONITION_ICON_CLASS.warning, "amber")).toBe(700);
    // Full strength: at 70% the note icon fell under the bar on `bg-muted`.
    expect(ADMONITION_ICON_CLASS.note).toBe("text-muted-foreground");
  });

  it("has an icon and a class for every type", () => {
    expect(Object.keys(ADMONITION_ICON).toSorted()).toEqual(
      Object.keys(ADMONITION_ICON_CLASS).toSorted()
    );
  });
});
