import { describe, expect, it } from "bun:test";

import { hasIcon, resolveIcon } from "../src/theme/icons.ts";

describe(resolveIcon, () => {
  it("resolves documented Mintlify icon names", () => {
    expect(resolveIcon("flag")?.name).toBe("flag");
    expect(resolveIcon("text-align-start")?.name).toBe("text-align-start");
    expect(resolveIcon("circle-check")?.name).toBe("circle-check");
  });

  it("accepts Font Awesome-style prefixes and iconType values", () => {
    expect(resolveIcon("fa-solid fa-key")?.name).toBe("key");
    expect(resolveIcon("fa-regular-flag", "regular")?.name).toBe("flag");
    expect(resolveIcon("x-twitter", "brands")?.name).toBe("brand-x");
  });

  it("normalizes common library aliases", () => {
    expect(resolveIcon("javascript")?.name).toBe("js");
    expect(resolveIcon("alien-8bit")?.name).toBe("sparkles");
    expect(hasIcon("tabler:panel-left-close")).toBeTruthy();
  });
});
