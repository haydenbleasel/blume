import { describe, expect, it } from "bun:test";

import { badgeColorName } from "../src/components/content/badge-color.ts";

describe(badgeColorName, () => {
  it("maps each documented variant to its hue", () => {
    expect(badgeColorName("default")).toBe("gray");
    // The theme accent, not a fixed hue.
    expect(badgeColorName("accent")).toBe("accent");
    expect(badgeColorName("success")).toBe("green");
    expect(badgeColorName("warning")).toBe("orange");
    expect(badgeColorName("danger")).toBe("red");
  });

  it("lets an explicit color win over the variant", () => {
    expect(badgeColorName("danger", "purple")).toBe("purple");
    expect(badgeColorName("default", "#f00")).toBe("#f00");
  });

  it("renders an unknown variant as the default gray badge", () => {
    expect(badgeColorName("info")).toBe("gray");
    // Not an inherited object key either.
    expect(badgeColorName("toString")).toBe("gray");
  });
});
