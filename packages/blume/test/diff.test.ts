import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { renderDiff } from "../src/components/content/diff.ts";

let root: string;

const PATCH = `--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-const value = "oldPatchValue";
+const value = "newPatchValue";
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-diff-"));
  await Promise.all([
    writeFile(join(root, "before.ts"), 'const value = "beforeFile";\n'),
    writeFile(join(root, "after.ts"), 'const value = "afterFile";\n'),
    writeFile(join(root, "change.patch"), PATCH),
  ]);
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("renderDiff", () => {
  it("renders inline old/new strings", async () => {
    const html = await renderDiff({
      lang: "ts",
      new: 'const value = "newInline";',
      old: 'const value = "oldInline";',
    });
    expect(html).toContain("oldInline");
    expect(html).toContain("newInline");
  });

  it("renders with inline custom Shiki themes", async () => {
    const html = await renderDiff({
      lang: "ts",
      new: "let value = 2;",
      old: "const value = 1;",
      theme: {
        dark: {
          colors: {
            "editor.background": "#010203",
            "editor.foreground": "#fefefe",
          },
          name: "acme-diff-dark",
          tokenColors: [],
          type: "dark",
        },
        light: "github-light",
      },
    });

    expect(html).toContain("#010203");
  });

  it("registers equal-content theme objects under one stable name", async () => {
    // Distinct object instances with identical content — as produced when a
    // dev-server reload re-evaluates the config module. The content-derived
    // registration name makes the second render an idempotent re-register
    // instead of a stale or duplicate entry.
    const theme = {
      colors: {
        "editor.background": "#040506",
        "editor.foreground": "#fefefe",
      },
      name: "acme-reload-dark",
      tokenColors: [],
      type: "dark" as const,
    };
    const options = {
      lang: "ts",
      new: "let value = 2;",
      old: "const value = 1;",
    };

    const first = await renderDiff({
      ...options,
      theme: { dark: theme, light: "github-light" },
    });
    const second = await renderDiff({
      ...options,
      theme: { dark: structuredClone(theme), light: "github-light" },
    });

    expect(second).toBe(first);
    expect(first).toContain("#040506");
  });

  it("registers a typeless theme object shared by both modes once per mode", async () => {
    // Without a per-mode memo, the light slot would reuse the dark-typed
    // registration made first. Rendering the shared object must match
    // rendering two independent copies, which register per mode correctly.
    const shared = {
      colors: {
        "editor.background": "#070809",
        "editor.foreground": "#fefefe",
      },
      name: "acme-shared",
      tokenColors: [],
    };
    const options = {
      lang: "ts",
      new: "let value = 2;",
      old: "const value = 1;",
    };

    const fromShared = await renderDiff({
      ...options,
      theme: { dark: shared, light: shared },
    });
    const fromCopies = await renderDiff({
      ...options,
      theme: {
        dark: structuredClone(shared),
        light: structuredClone(shared),
      },
    });

    expect(fromShared).toBe(fromCopies);
    expect(fromShared).toContain("#070809");
  });

  it("renders with a settings-form (TextMate) custom theme", async () => {
    const html = await renderDiff({
      lang: "ts",
      new: "let value = 2;",
      old: "const value = 1;",
      theme: {
        dark: "github-dark",
        light: {
          name: "acme-diff-light",
          settings: [
            { scope: ["keyword"], settings: { foreground: "#abcdef" } },
          ],
          type: "light" as const,
        },
      },
    });

    // Shiki normalizes token colors to uppercase hex.
    expect(html).toContain("#ABCDEF");
  });

  it("renders before/after file paths (absolute)", async () => {
    const html = await renderDiff({
      after: join(root, "after.ts"),
      before: join(root, "before.ts"),
    });
    expect(html).toContain("beforeFile");
    expect(html).toContain("afterFile");
  });

  it("resolves before/after relative to root", async () => {
    const html = await renderDiff({
      after: "after.ts",
      before: "before.ts",
      root,
    });
    expect(html).toContain("afterFile");
  });

  it("renders an inline unified patch", async () => {
    const html = await renderDiff({ patch: PATCH });
    expect(html).toContain("oldPatchValue");
    expect(html).toContain("newPatchValue");
  });

  it("renders a patch read from a src file", async () => {
    const html = await renderDiff({ root, src: "change.patch" });
    expect(html).toContain("newPatchValue");
  });

  it("throws when no input group is given", async () => {
    await expect(renderDiff({})).rejects.toThrow(/requires one input/u);
  });

  it("throws when before is given without after", async () => {
    await expect(renderDiff({ before: "before.ts", root })).rejects.toThrow(
      /both `before` and `after`/u
    );
  });

  it("throws when old is given without new", async () => {
    await expect(renderDiff({ old: "x" })).rejects.toThrow(
      /both `old` and `new`/u
    );
  });
});
