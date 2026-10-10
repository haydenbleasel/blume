import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { catchAllPageTemplate } from "../src/astro/templates.ts";
import { mountBase } from "../src/components/islands/base-path.ts";

interface ImageScope {
  base: string | null;
  data: {
    config: {
      og: { enabled: boolean; image?: string | Record<string, string> };
    };
  };
  locale: string;
  ogCardGenerated: boolean;
  ogEnabled: boolean;
  ogImage?: string;
  ogSlug: string;
  route: string;
  seo: { image?: string };
  siteBase: string | null;
  withBase: (path: string) => string;
  withMountedBase: (path: string) => string;
}
interface SelectedImage {
  generated: boolean;
  image: string | null;
}

/** Execute the actual image-selection code from the generated page or layout. */
const select = (
  source: string,
  start: string,
  end: string,
  result: string,
  scope: ImageScope
): SelectedImage => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  expect(first).toBeGreaterThan(-1);
  expect(last).toBeGreaterThan(first);
  const snippet = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.slice(first, last)
  );
  // oxlint-disable-next-line no-new-func -- executes the generated code under test
  return new Function(
    "scope",
    `with (scope) { ${snippet}\nreturn { image: ${result}, generated: ogGenerated }; }`
  )(scope);
};

const scopeFor = (
  image?: string | Record<string, string>,
  override?: string
): ImageScope => ({
  base: "https://example.com",
  data: { config: { og: { enabled: true, image } } },
  locale: "fr",
  ogCardGenerated: true,
  ogEnabled: true,
  ogImage: override,
  ogSlug: "fr/guide",
  route: "/fr/guide",
  seo: { image: override },
  siteBase: "https://example.com",
  withBase: (path) => mountBase("/sub", path),
  withMountedBase: (path) => mountBase("/sub", path),
});

describe("social image selection", () => {
  it("uses page overrides, shared and locale defaults, and generated fallback in both layouts", async () => {
    const sources = [
      {
        end: "// X attribution",
        result: "ogImage",
        source: catchAllPageTemplate({
          exportEpub: false,
          exportPdf: false,
          mathEnabled: false,
          needsReact: false,
        }),
        start: "const ogPath =",
      },
      {
        end: "// A page with no image",
        result: "resolvedOgImage",
        source: await readFile(
          new URL("../src/components/layout/PageLayout.astro", import.meta.url),
          "utf-8"
        ),
        start: "const absolutizeOgImage =",
      },
    ];
    for (const { source, start, end, result } of sources) {
      const run = (scope: ImageScope) =>
        select(source, start, end, result, scope);
      expect(run(scopeFor("/default.png"))).toEqual({
        generated: false,
        image: "https://example.com/sub/default.png",
      });
      expect(run(scopeFor({ en: "/en.png", fr: "/fr.png" }))).toEqual({
        generated: false,
        image: "https://example.com/sub/fr.png",
      });
      expect(
        run(scopeFor("/default.png", "https://cdn.example.com/page.png"))
      ).toEqual({
        generated: false,
        image: "https://cdn.example.com/page.png",
      });
      expect(run(scopeFor({ en: "/en.png" }))).toEqual({
        generated: true,
        image: "https://example.com/sub/og/fr/guide.png",
      });
      const disabled = scopeFor("/default.png");
      disabled.data.config.og.enabled = false;
      disabled.ogEnabled = false;
      expect(run(disabled)).toEqual({
        generated: false,
        image: "https://example.com/sub/default.png",
      });
      disabled.data.config.og.image = undefined;
      expect(run(disabled)).toEqual({ generated: false, image: null });
    }
  });
});
