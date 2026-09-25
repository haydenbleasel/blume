import { describe, expect, it } from "bun:test";

import { i18nDiagnostics } from "../src/core/i18n.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type {
  BlumeConfigInput,
  ResolvedI18nConfig,
} from "../src/core/schema.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";
import type { PageRecord } from "../src/core/types.ts";

type I18nInput = Partial<NonNullable<BlumeConfigInput["i18n"]>>;

const i18nOf = (over: I18nInput = {}): ResolvedI18nConfig => {
  const { i18n } = blumeConfigSchema.parse({
    i18n: {
      defaultLocale: "en",
      locales: [
        { code: "en", label: "English" },
        { code: "fr", label: "Français" },
      ],
      ...over,
    },
  });
  if (!i18n) {
    throw new Error("expected i18n");
  }
  return i18n;
};

const pagesOf = (refs: string[], i18n: ResolvedI18nConfig): PageRecord[] =>
  refs.flatMap(
    (ref) =>
      normalizeEntry(
        { body: { format: "md", text: "" }, data: {}, ref },
        { defaultType: "doc", i18n, source: { name: "s", staged: false } }
      ).pages
  );

describe("a folder named after the default locale", () => {
  it("warns once, naming the route its pages publish at", () => {
    const i18n = i18nOf();
    const pages = pagesOf(["en/guide.md", "en/setup.md", "index.md"], i18n);
    expect(pages[0]?.route).toBe("/en/guide");
    const diagnostics = i18nDiagnostics(pages, i18n);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "BLUME_I18N_DEFAULT_LOCALE_FOLDER",
      severity: "warning",
    });
    expect(diagnostics[0]?.message).toContain('Folder "en/"');
    expect(diagnostics[0]?.message).toContain("publish at /en/…");
  });

  it("names the doubled prefix when the default locale is prefixed", () => {
    const i18n = i18nOf({ hideDefaultLocalePrefix: false });
    const pages = pagesOf(["EN/guide.md"], i18n);
    expect(pages[0]?.route).toBe("/en/EN/guide");
    const [diagnostic] = i18nDiagnostics(pages, i18n);
    expect(diagnostic?.message).toContain("publish at /en/EN/…");
  });

  it("leaves a root-level page named after the locale alone", () => {
    const i18n = i18nOf();
    expect(i18nDiagnostics(pagesOf(["en.md", "fr/en.md"], i18n), i18n)).toEqual(
      []
    );
  });
});
