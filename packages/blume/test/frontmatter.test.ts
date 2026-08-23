import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import baseMatter from "gray-matter";
import yaml from "js-yaml";
import { join } from "pathe";

import matter from "../src/core/frontmatter.ts";

const doc = "---\ntitle: Home\ncount: 2\n---\nbody text";

// `safeLoad` was removed from js-yaml 4's types, but the runtime still ships a
// stub that throws — that is exactly what crashes gray-matter's default engine.
// SAFETY: js-yaml 4's module object carries a runtime `safeLoad` stub its types
// no longer declare (hence the optional probe); the test below asserts the
// stub exists and throws.
const removedSafeLoad = (yaml as { safeLoad?: (input: string) => object })
  .safeLoad as (input: string) => object;

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("frontmatter wrapper", () => {
  it("parses front matter into data and content", () => {
    const parsed = matter(doc);

    expect(parsed.data).toEqual({ count: 2, title: "Home" });
    expect(parsed.content).toBe("body text");
  });

  it("round-trips through stringify", () => {
    const out = matter.stringify("body text", { count: 2, title: "Home" });
    const back = matter(out);

    expect(back.data).toEqual({ count: 2, title: "Home" });
    expect(back.content.trim()).toBe("body text");
  });

  it("stringify emits a string body verbatim, never re-parsing it", () => {
    // gray-matter runs `matter()` over a string body first, so a body that
    // opens with a `---` divider would read as a second front matter block:
    // js-yaml throws on `Intro: with a colon` or swallows it into the header.
    const body = "---\n\nIntro: with a colon.\n\n## Section\n";
    const out = matter.stringify(body, { title: "Divider" });
    expect(out).toBe(`---\ntitle: Divider\n---\n${body}`);
    expect(() =>
      matter.stringify("---\ntitle: Not YAML: [\n", { title: "T" })
    ).not.toThrow();
    // An object body still passes straight through.
    expect(matter.stringify({ content: "plain\n" }, { title: "T" })).toBe(
      "---\ntitle: T\n---\nplain\n"
    );
  });

  it("treats empty front matter as an empty object", () => {
    expect(matter("---\n---\nbody").data).toEqual({});
  });

  it("keeps a thematic break at the top of the body after real front matter", () => {
    const parsed = matter("---\ntitle: Test\n---\n---\n\n## Section\n");
    expect(parsed.data).toEqual({ title: "Test" });
    expect(parsed.content).toBe("---\n\n## Section\n");
  });

  it("treats a leading --- followed by a blank line as content, not a fence", () => {
    // A Notion page whose first block is a divider exports exactly this shape;
    // gray-matter read it as one unclosed YAML block and js-yaml crashed on
    // the blockquote with "a line break is expected".
    const divider = "---\n\n## Section\n\n> ℹ️ Note\n";
    const parsed = matter(divider);
    expect(parsed.data).toEqual({});
    expect(parsed.content).toBe(divider);
    // Recomposing a no-matter file is the content itself.
    expect(parsed.stringify("")).toBe(divider);
  });

  it("treats an unclosed leading --- block as content, not YAML", () => {
    const unclosed = "---\n## Section\n\n> ℹ️ Note\n";
    const parsed = matter(unclosed);
    expect(parsed.data).toEqual({});
    expect(parsed.content).toBe(unclosed);
  });

  it("treats a document that is only a thematic break as content", () => {
    expect(matter("---").content).toBe("---");
    expect(matter("---\n").content).toBe("---\n");
  });

  it("avoids the js-yaml 4 `safeLoad` removal that crashes gray-matter's default engine", () => {
    // gray-matter@4's default YAML engine is `yaml.safeLoad`, which was removed
    // in js-yaml 4 and now throws. Wiring that engine in explicitly reproduces
    // the reported `blume dev` crash in a workspace pinned to js-yaml 4...
    expect(removedSafeLoad).toBeInstanceOf(Function);
    expect(() =>
      baseMatter(doc, { engines: { yaml: { parse: removedSafeLoad } } })
    ).toThrow(/safeLoad is removed/u);

    // ...while the wrapper supplies `load`/`dump`, which exist in js-yaml 3 and 4.
    expect(matter(doc).data).toEqual({ count: 2, title: "Home" });
  });

  it("wraps `read` with the injected engine instead of copying gray-matter's", async () => {
    // `Object.assign(fn, baseMatter, …)` used to copy gray-matter's own `read`
    // unwrapped, so `matter.read(file)` parsed with the default `safeLoad`
    // engine — the exact js-yaml 4 crash this wrapper exists to prevent.
    expect(matter.read).not.toBe(baseMatter.read);

    const dir = await mkdtemp(join(tmpdir(), "blume-frontmatter-"));
    dirs.push(dir);
    const file = join(dir, "doc.md");
    await writeFile(file, "---\ntitle: Read\nnested:\n  a: 1\n---\nread body");

    const parsed = matter.read(file);
    expect(parsed.data).toEqual({ nested: { a: 1 }, title: "Read" });
    expect(parsed.content).toBe("read body");

    // Caller-supplied engines still win over the injected default, matching
    // the bare `matter()` call: the broken engine surfaces its own error.
    expect(() =>
      matter.read(file, { engines: { yaml: { parse: removedSafeLoad } } })
    ).toThrow(/safeLoad is removed/u);
  });
});
