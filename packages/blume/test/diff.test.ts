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
