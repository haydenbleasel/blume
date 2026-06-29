import { describe, expect, it } from "bun:test";

import { resolveSlot } from "../src/components/layout/overrides.ts";

const Builtin = () => "builtin";
const Override = () => "override";

describe("resolveSlot", () => {
  it("falls back to the built-in when no override is configured", () => {
    expect(resolveSlot(undefined, Builtin)).toBe(Builtin);
  });

  it("uses an imported component override directly", () => {
    expect(resolveSlot(Override, Builtin)).toBe(Override);
  });

  it("unwraps an IslandDescriptor to its component", () => {
    expect(resolveSlot({ client: "load", component: Override }, Builtin)).toBe(
      Override
    );
  });

  it("ignores string-path overrides for now and keeps the built-in", () => {
    expect(resolveSlot("./header.astro", Builtin)).toBe(Builtin);
  });
});
