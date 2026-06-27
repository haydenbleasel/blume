import { describe, expect, it } from "bun:test";

import { findItem, itemsRoot, registry } from "../src/registry/registry.ts";

describe("registry", () => {
  it("finds a registered item by name", () => {
    const item = findItem("feedback");
    expect(item?.name).toBe("feedback");
    expect(item?.files.length).toBeGreaterThan(0);
    expect(item?.postInstall.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown item", () => {
    expect(findItem("does-not-exist")).toBeUndefined();
  });

  it("exposes a non-empty registry and an items root path", () => {
    expect(registry.length).toBeGreaterThan(0);
    expect(itemsRoot.endsWith("items")).toBe(true);
  });
});
