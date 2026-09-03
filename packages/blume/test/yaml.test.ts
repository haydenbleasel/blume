import { describe, expect, it } from "bun:test";

import { load } from "js-yaml";

import { YAML_SCHEMA } from "../src/core/yaml.ts";

describe("yaml", () => {
  it("keeps js-yaml 4's default schema: timestamps become Dates and merge keys resolve", () => {
    const src =
      "date: 2024-01-01\nbase: &b\n  x: 1\nchild:\n  <<: *b\n  y: 2\n";
    expect(load(src, { schema: YAML_SCHEMA })).toEqual({
      base: { x: 1 },
      child: { x: 1, y: 2 },
      date: new Date("2024-01-01T00:00:00Z"),
    });
    // js-yaml 5's bare loader hands back a string and an unresolved `<<` key —
    // the drift the pinned schema exists to prevent.
    expect(load(src)).toEqual({
      base: { x: 1 },
      child: { "<<": { x: 1 }, y: 2 },
      date: "2024-01-01",
    });
  });

  it("parses YAML 1.2 core scalars like js-yaml 4 (`yes` stays a string)", () => {
    expect(
      load("flag: yes\nhex: 0xff\nnothing: ~\nid: 1_000", {
        schema: YAML_SCHEMA,
      })
    ).toEqual({
      flag: "yes",
      hex: 255,
      id: "1_000",
      nothing: null,
    });
  });
});
