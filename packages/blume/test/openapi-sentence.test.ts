import { describe, expect, it } from "bun:test";

import { asSentence } from "../src/openapi/sentence.ts";

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

  it("leaves a colon inside the prose alone", () => {
    expect(asSentence("Scale the ratio to 1:2")).toBe(
      "Scale the ratio to 1:2."
    );
  });

  it("keeps empty prose empty", () => {
    expect(asSentence("")).toBe("");
  });
});
