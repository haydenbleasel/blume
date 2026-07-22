import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  discoverExamples,
  exampleMarkdownLookup,
} from "../src/astro/examples.ts";

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

  it("reads from a configured subdir, keying paths relative to it", async () => {
    // A registry-style layout: examples live under registry/<pkg>/, not a
    // top-level examples/. The path key is relative to the configured dir.
    const reg = await mkdtemp(join(tmpdir(), "blume-examples-reg-"));
    const file = join(reg, "registry", "files-sdk", "file-list", "basic.tsx");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "export default function FileList() {}");

    // The default subdir doesn't see it.
    const fromDefault = await discoverExamples(reg);
    expect(fromDefault.examples).toHaveLength(0);

    const map = byPath(await discoverExamples(reg, "registry/files-sdk"));
    expect(map.has("file-list/basic")).toBe(true);
    expect(map.get("file-list/basic")?.framework).toBe("react");

    await rm(reg, { force: true, recursive: true });
  });

  it("accepts a glob, keying paths relative to its static prefix", async () => {
    // A shadcn registry colocates each component's source (named exports, no
    // default — the registry payload) with its example (default export). A bare
    // dir would glob the sources too and fail to wrap them; a glob targets only
    // the examples, keyed relative to the static prefix before the first wildcard.
    const reg = await mkdtemp(join(tmpdir(), "blume-examples-glob-"));
    const dir = join(reg, "registry", "files-sdk", "file-list");
    const source = join(dir, "file-list.tsx");
    const example = join(dir, "examples", "file-list-basic.tsx");
    await mkdir(dirname(example), { recursive: true });
    await writeFile(source, "export function FileList() {}");
    await writeFile(example, "export default function Basic() {}");

    const map = byPath(
      await discoverExamples(reg, "registry/files-sdk/**/examples/*")
    );
    // The example is addressable, keyed relative to `registry/files-sdk`.
    expect(map.has("file-list/examples/file-list-basic")).toBe(true);
    // The colocated source (no default export to wrap) isn't swept in.
    expect(map.has("file-list/file-list")).toBe(false);
    expect(map.size).toBe(1);

    await rm(reg, { force: true, recursive: true });
  });
});

describe("exampleMarkdownLookup", () => {
  it("keys each example's lang and source by its <Component path>", async () => {
    const { examples } = await discoverExamples(root);
    const lookup = exampleMarkdownLookup(examples);
    expect(lookup["forms/login"]).toStrictEqual({
      lang: "tsx",
      source: "export default function Login() {}",
    });
    expect(lookup.counter?.lang).toBe("tsx");
    expect(Object.keys(lookup)).toHaveLength(examples.length);
  });
});
