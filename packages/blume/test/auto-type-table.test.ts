import { describe, expect, it } from "bun:test";

import { extractTypeTable } from "../src/components/content/auto-type-table.ts";

describe(extractTypeTable, () => {
  it("extracts properties with descriptions, optionality, and @default", async () => {
    const rows = await extractTypeTable({
      name: "Props",
      source: `
        export interface Props {
          /** The user's name. */
          name: string;
          /**
           * Maximum results to return.
           * @default 20
           */
          limit?: number;
          tags: string[];
        }
      `,
    });

    expect(rows.map((row) => row.name)).toEqual(["name", "limit", "tags"]);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName.name).toMatchObject({
      description: "The user's name.",
      required: true,
      type: "string",
    });
    expect(byName.limit).toMatchObject({
      default: "20",
      required: false,
      type: "number",
    });
    expect(byName.tags).toMatchObject({ required: true, type: "string[]" });
  });

  it("supports type aliases with object types", async () => {
    const rows = await extractTypeTable({
      name: "Options",
      source: "export type Options = { id: string; verbose?: boolean };",
    });

    expect(rows.map((row) => row.name).toSorted()).toEqual(["id", "verbose"]);
    expect(rows.find((row) => row.name === "verbose")?.required).toBe(false);
  });

  it("throws when the named type is missing", async () => {
    await expect(
      extractTypeTable({
        name: "Nope",
        source: "export interface Yes { a: string }",
      })
    ).rejects.toThrow(/No interface or type named "Nope"/u);
  });
});
