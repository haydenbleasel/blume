import { describe, expect, it } from "bun:test";

import { asSentence, closeSentence } from "../src/openapi/sentence.ts";

describe("asSentence", () => {
  it("closes title-like prose with a period", () => {
    expect(asSentence("Get a flag")).toBe("Get a flag.");
  });

  it("leaves prose that already ends a sentence alone", () => {
    for (const text of [
      "Done.",
      "Really?",
      "Stop!",
      "And so on…",
      'He said "done."',
      "(See the guide.)",
      "完了。",
    ]) {
      expect(asSentence(text)).toBe(text);
    }
  });

  it("closes a lead-in that ends in a colon instead of stacking a period on it", () => {
    // The first paragraph of "Supports two modes:\n\n- Explicit IDs …" is the lead-in alone.
    expect(asSentence("Delete in parallel. Supports two modes:")).toBe(
      "Delete in parallel. Supports two modes."
    );
    expect(asSentence("Supports two modes: ")).toBe("Supports two modes.");
  });

  it("keeps the mark a lead-in already ended on", () => {
    expect(asSentence("Accepts several formats, e.g.:")).toBe(
      "Accepts several formats, e.g."
    );
    expect(asSentence("Why bulk?:")).toBe("Why bulk?");
    expect(asSentence("Wait…:")).toBe("Wait…");
  });

  it("drops the space French typesetting puts before the colon", () => {
    expect(asSentence("Deux modes :")).toBe("Deux modes.");
    expect(asSentence("Deux modes :")).toBe("Deux modes.");
  });

  it("closes a lead-in that ends in a full-width colon", () => {
    expect(asSentence("支持两种模式：")).toBe("支持两种模式.");
  });

  it("leaves a colon inside the prose alone", () => {
    expect(asSentence("Scale the ratio to 1:2")).toBe(
      "Scale the ratio to 1:2."
    );
  });

  it("keeps a colon that belongs to a literal", () => {
    expect(asSentence("Deploys the app :rocket:")).toBe(
      "Deploys the app :rocket:."
    );
    expect(asSentence("Resolve Foo::")).toBe("Resolve Foo::.");
  });

  it("keeps empty prose empty, including a lone colon", () => {
    expect(asSentence("")).toBe("");
    expect(asSentence(":")).toBe("");
    expect(asSentence(" : ")).toBe("");
  });
});

describe("closeSentence", () => {
  it("closes prose and keeps a trailing colon the caller knows is literal", () => {
    expect(closeSentence("Get a flag")).toBe("Get a flag.");
    expect(closeSentence("Done.")).toBe("Done.");
    expect(closeSentence("Keys are prefixed with tenant:")).toBe(
      "Keys are prefixed with tenant:."
    );
    expect(closeSentence("")).toBe("");
  });
});
