import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { discoverExamples } from "../src/astro/examples.ts";

let root: string;

// filename -> file contents (keys sorted to satisfy sort-keys)
const FILES: Record<string, string> = {
  "examples/Card.astro": "<div>card</div>",
  "examples/counter.tsx": "export default function Counter() { return null; }",
  "examples/eager.jsx":
    'export const client = "load";\nexport default function Eager() {}',
  // Nested path key, distinct from the top-level `counter`.
  "examples/forms/login.tsx": "export default function Login() {}",
  "examples/toggle.svelte": "<button>toggle</button>",
  "examples/widget.vue": "<template><div /></template>",
};

const byPath = (discovery: Awaited<ReturnType<typeof discoverExamples>>) =>
  new Map(discovery.examples.map((example) => [example.path, example]));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-examples-"));
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

describe("discoverExamples", () => {
  it("keys examples by their path under examples/, without extension", async () => {
    const map = byPath(await discoverExamples(root));
    expect(map.has("counter")).toBe(true);
    expect(map.has("forms/login")).toBe(true);
    expect(map.get("counter")?.lang).toBe("tsx");
  });

  it("infers framework from the extension, including astro", async () => {
    const map = byPath(await discoverExamples(root));
    expect(map.get("counter")?.framework).toBe("react");
    expect(map.get("widget")?.framework).toBe("vue");
    expect(map.get("toggle")?.framework).toBe("svelte");
    expect(map.get("Card")?.framework).toBe("astro");
  });

  it("gives astro examples no client directive", async () => {
    expect(byPath(await discoverExamples(root)).get("Card")?.client).toBe(
      undefined
    );
  });

  it("defaults framework examples to client:visible", async () => {
    expect(byPath(await discoverExamples(root)).get("counter")?.client).toBe(
      "visible"
    );
  });

  it("reads an explicit client mode without executing the file", async () => {
    expect(byPath(await discoverExamples(root)).get("eager")?.client).toBe(
      "load"
    );
  });

  it("captures the raw source for the code pane", async () => {
    expect(byPath(await discoverExamples(root)).get("toggle")?.source).toBe(
      "<button>toggle</button>"
    );
  });

  it("ignores a duplicate path with a warning", async () => {
    const dupRoot = await mkdtemp(join(tmpdir(), "blume-examples-dup-"));
    await mkdir(join(dupRoot, "examples"), { recursive: true });
    // `card.tsx` and `card.astro` both resolve to the path key `card`.
    await writeFile(join(dupRoot, "examples", "card.astro"), "<div />");
    await writeFile(
      join(dupRoot, "examples", "card.tsx"),
      "export default function Card() {}"
    );
    const result = await discoverExamples(dupRoot);
    expect(result.examples.filter((e) => e.path === "card")).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('"card"'))).toBe(true);
    await rm(dupRoot, { force: true, recursive: true });
  });

  it("returns nothing when examples/ is absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "blume-no-examples-"));
    const result = await discoverExamples(empty);
    expect(result.examples).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    await rm(empty, { force: true, recursive: true });
  });
});
