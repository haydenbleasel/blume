import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { discoverIslands } from "../src/astro/islands.ts";

let root: string;

// filename -> file contents (keys sorted to satisfy sort-keys)
const FILES = {
  "islands/Bad.tsx":
    'export const client = "whenever";\nexport default function Bad() {}',
  "islands/Chart.jsx":
    'export const client: ClientMode = "only";\nexport default function Chart() {}',
  "islands/Counter.tsx": "export default function Counter() { return null; }",
  "islands/Eager.tsx":
    'export const client = "load";\nexport default function Eager() {}',
  // Uppercase first letter but a non-identifier char — would emit a
  // syntax-error object key (`Time-Picker: I0`) if not skipped.
  "islands/Time-Picker.tsx": "export default function TimePicker() {}",
  "islands/Toggle.svelte": "<button>toggle</button>",
  "islands/Widget.vue": "<template><div /></template>",
  // Nested duplicate of <Counter> — should be ignored with a warning.
  "islands/nested/Counter.tsx": "export default function Counter() {}",
  // Not an island extension — should be skipped silently.
  "islands/notes.md": "# Island notes",
  // Lowercase filename can't be a JSX tag — should be skipped.
  "islands/widget.tsx": "export default function widget() {}",
} satisfies Record<string, string>;

const byName = (discovery: Awaited<ReturnType<typeof discoverIslands>>) =>
  new Map(discovery.islands.map((island) => [island.name, island]));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-islands-"));
  await Promise.all(
    Object.entries(FILES).map(async ([rel, body]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body);
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("discoverIslands", () => {
  it("defaults to client:visible when no mode is declared", async () => {
    const result = await discoverIslands(root);
    expect(byName(result).get("Counter")?.client).toBe("visible");
  });

  it("reads an explicit client mode without executing the file", async () => {
    const result = await discoverIslands(root);
    expect(byName(result).get("Eager")?.client).toBe("load");
  });

  it("infers react / vue / svelte from the file extension", async () => {
    const map = byName(await discoverIslands(root));
    expect(map.get("Counter")?.framework).toBe("react");
    expect(map.get("Widget")?.framework).toBe("vue");
    expect(map.get("Toggle")?.framework).toBe("svelte");
  });

  it("reads a mode declared with a type annotation", async () => {
    const result = await discoverIslands(root);
    expect(byName(result).get("Chart")?.client).toBe("only");
  });

  it("warns and falls back to visible on an unknown mode", async () => {
    const result = await discoverIslands(root);
    expect(byName(result).get("Bad")?.client).toBe("visible");
    expect(result.warnings.some((w) => w.includes("whenever"))).toBe(true);
  });

  it("skips non-PascalCase filenames with a warning", async () => {
    const result = await discoverIslands(root);
    expect(byName(result).has("widget")).toBe(false);
    expect(result.warnings.some((w) => w.includes("PascalCase"))).toBe(true);
  });

  it("skips a PascalCase-but-non-identifier filename with a warning", async () => {
    const result = await discoverIslands(root);
    // `Time-Picker` starts uppercase but isn't a valid identifier/tag.
    expect(byName(result).has("Time-Picker")).toBe(false);
    expect(result.warnings.some((w) => w.includes("Time-Picker.tsx"))).toBe(
      true
    );
  });

  it("ignores a duplicate component name with a warning", async () => {
    const result = await discoverIslands(root);
    const counters = result.islands.filter((i) => i.name === "Counter");
    expect(counters).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("<Counter>"))).toBe(true);
  });

  it("skips a non-island extension silently", async () => {
    const result = await discoverIslands(root);
    expect(result.islands.some((i) => i.file.endsWith("notes.md"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("notes.md"))).toBe(false);
  });

  it("returns no islands and no warnings when islands/ is absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "blume-no-islands-"));
    const result = await discoverIslands(empty);
    expect(result.islands).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    await rm(empty, { force: true, recursive: true });
  });
});
