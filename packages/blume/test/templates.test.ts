import { describe, expect, it } from "bun:test";

import {
  catchAllPageTemplate,
  changelogIndexTemplate,
  userComponentsTemplate,
} from "../src/astro/templates.ts";

const exportOpts = { askEnabled: false, exportEpub: false, exportPdf: false };

describe("userComponentsTemplate", () => {
  it("exports empty override maps when no components file exists", () => {
    const out = userComponentsTemplate(null);
    expect(out).toContain("export const mdxComponents = {}");
    expect(out).toContain("export const layoutOverrides = {}");
    expect(out).toContain("export const islands = {}");
  });

  it("re-exports mdx, layout, and islands from the user file", () => {
    const out = userComponentsTemplate("../../components.ts");
    expect(out).toContain('import overrides from "../../components.ts"');
    expect(out).toContain("export const mdxComponents = overrides.mdx ?? {}");
    expect(out).toContain(
      "export const layoutOverrides = overrides.layout ?? {}"
    );
    expect(out).toContain("export const islands = overrides.islands ?? {}");
  });
});

describe("catchAllPageTemplate", () => {
  it("imports layout overrides and passes them to RootLayout", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).toContain(
      'import { mdxComponents as userMdx, layoutOverrides } from "../generated/components.ts"'
    );
    expect(out).toContain("layout={layoutOverrides}");
  });

  it("no longer imports the removed Warning component", () => {
    const out = catchAllPageTemplate({ ...exportOpts, mathEnabled: false });
    expect(out).not.toContain("Warning");
  });
});

describe("changelogIndexTemplate", () => {
  it("imports layout overrides and passes them to RootLayout", () => {
    const out = changelogIndexTemplate(exportOpts);
    expect(out).toContain(
      'import { layoutOverrides } from "../generated/components.ts"'
    );
    expect(out).toContain("layout={layoutOverrides}");
  });
});
