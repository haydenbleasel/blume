import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { join } from "pathe";

import {
  findItem,
  itemsRoot,
  packageSrc,
  registry,
} from "../src/registry/registry.ts";
import { rewriteImports } from "../src/registry/rewrite-imports.ts";

const BLUME_SPEC = /["']blume\/(?<path>[^"']+)["']/gu;

describe("registry", () => {
  it("finds a registered item by name", () => {
    const item = findItem("feedback");
    expect(item?.name).toBe("feedback");
    expect(item?.files.length).toBeGreaterThan(0);
    expect(item?.postInstall.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown item", () => {
    expect(findItem("does-not-exist")).toBeUndefined();
  });

  it("exposes a non-empty registry and an items root path", () => {
    expect(registry.length).toBeGreaterThan(0);
    expect(itemsRoot.endsWith("items")).toBe(true);
  });

  it("offers the overridable layout slots as editable source", () => {
    for (const name of [
      "header",
      "sidebar",
      "breadcrumbs",
      "table-of-contents",
      "pagination",
    ]) {
      expect(findItem(name)?.files[0]?.rewrite).toBe(true);
    }
  });
});

describe("registry layout components", () => {
  const rewritten = registry.filter((item) =>
    item.files.some((file) => file.rewrite)
  );

  for (const item of rewritten) {
    it(`${item.name}: every rewritten import resolves to a real package file`, () => {
      for (const file of item.files) {
        const source = join(packageSrc, file.source);
        expect(existsSync(source)).toBe(true);
        const out = rewriteImports(
          readFileSync(source, "utf-8"),
          source,
          packageSrc
        );
        const specs = [...out.matchAll(BLUME_SPEC)].flatMap((match) => {
          const path = match.groups?.path;
          return path ? [path] : [];
        });
        expect(specs.length).toBeGreaterThan(0);
        for (const spec of specs) {
          expect(existsSync(join(packageSrc, spec))).toBe(true);
        }
      }
    });
  }
});
