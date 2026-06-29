import { describe, expect, it } from "bun:test";

import { rewriteImports } from "../src/registry/rewrite-imports.ts";

const SRC = "/pkg/src";
const FILE = "/pkg/src/components/layout/Pagination.astro";

describe("rewriteImports", () => {
  it("maps a parent-dir core import to blume/core/*", () => {
    const out = rewriteImports(
      'import type { UIStrings } from "../../core/i18n-ui.ts";',
      FILE,
      SRC
    );
    expect(out).toContain('from "blume/core/i18n-ui.ts"');
  });

  it("maps a sibling import to blume/components/layout/*", () => {
    const out = rewriteImports(
      'import type { FlatPage } from "./nav-utils.ts";',
      FILE,
      SRC
    );
    expect(out).toContain('from "blume/components/layout/nav-utils.ts"');
  });

  it("maps a parent-components import", () => {
    const out = rewriteImports('import Icon from "../Icon.astro";', FILE, SRC);
    expect(out).toContain('from "blume/components/Icon.astro"');
  });

  it("rewrites side-effect and export-from statements", () => {
    expect(rewriteImports('import "./toc-element.ts";', FILE, SRC)).toContain(
      'import "blume/components/layout/toc-element.ts"'
    );
    expect(
      rewriteImports('export type { X } from "./y.ts";', FILE, SRC)
    ).toContain('from "blume/components/layout/y.ts"');
  });

  it("keeps a component's self-reference relative", () => {
    const navtree = "/pkg/src/components/layout/NavTree.astro";
    const out = rewriteImports(
      'import Self from "./NavTree.astro";',
      navtree,
      SRC
    );
    expect(out).toContain('from "./NavTree.astro"');
    expect(out).not.toContain("blume/");
  });

  it("leaves bare and already-package specifiers untouched", () => {
    const src =
      'import { useState } from "react";\nimport Icon from "blume/components/Icon.astro";';
    expect(rewriteImports(src, FILE, SRC)).toBe(src);
  });
});
