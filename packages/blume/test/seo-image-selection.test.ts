import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  catchAllPageTemplate,
  changelogIndexTemplate,
} from "../src/astro/templates.ts";
import { mountBase } from "../src/components/islands/base-path.ts";
import { resolveLocalizable } from "../src/core/localizable.ts";

interface ImageScope {
  base: string | null;
  data: {
    config: {
      i18n: { defaultLocale: string } | null;
      og: { enabled: boolean; image?: string | Record<string, string> };
    };
  };
  htmlLang: string;
  i18n: { defaultLocale: string } | null;
  locale: string;
  ogCardGenerated: boolean;
  ogEnabled: boolean;
  ogImage?: string;
  ogSlug: string;
  resolveLocalizable: typeof resolveLocalizable;
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
  scope: ImageScope,
  generated = "ogGenerated"
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
    `with (scope) { ${snippet}\nreturn { image: ${result}, generated: ${generated} }; }`
  )(scope);
};

const scopeFor = (
  image?: string | Record<string, string>,
  override?: string
): ImageScope => ({
  base: "https://example.com",
  data: {
    config: { i18n: { defaultLocale: "en" }, og: { enabled: true, image } },
  },
  htmlLang: "fr",
  i18n: { defaultLocale: "en" },
  locale: "fr",
  ogCardGenerated: true,
  ogEnabled: true,
  ogImage: override,
  ogSlug: "fr/guide",
  resolveLocalizable,
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
      // A locale without its own image takes the default locale's, like any
      // localizable label.
      expect(run(scopeFor({ de: "/de.png", en: "/en.png" }))).toEqual({
        generated: false,
        image: "https://example.com/sub/en.png",
      });
      // Without a site URL, a root-relative image still carries the base.
      const siteless = scopeFor("/default.png");
      siteless.base = null;
      siteless.siteBase = null;
      expect(run(siteless)).toEqual({
        generated: false,
        image: "/sub/default.png",
      });
      expect(run(scopeFor())).toEqual({
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

  it("gives the changelog index the default image over its card", () => {
    const source = changelogIndexTemplate({
      exportEpub: false,
      exportPdf: false,
      needsReact: false,
    });
    const run = (scope: ImageScope) =>
      select(
        source,
        "const defaultOgImage =",
        "// The page chrome",
        "ogImage",
        scope,
        "!defaultOgImage && Boolean(ogImage)"
      );
    expect(run(scopeFor({ en: "/en.png", fr: "/fr.png" }))).toEqual({
      generated: false,
      image: "https://example.com/sub/fr.png",
    });
    expect(run(scopeFor("https://cdn.example.com/og.png"))).toEqual({
      generated: false,
      image: "https://cdn.example.com/og.png",
    });
    const siteless = scopeFor("/default.png");
    siteless.base = null;
    expect(run(siteless)).toEqual({
      generated: false,
      image: "/sub/default.png",
    });
    expect(run(scopeFor())).toEqual({
      generated: true,
      image: "https://example.com/sub/og/changelog.png",
    });
  });
});
