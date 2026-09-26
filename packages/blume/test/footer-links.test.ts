import { describe, expect, it } from "bun:test";

import { footerLinks } from "../src/components/layout/footer-links.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

const { footer } = blumeConfigSchema.parse({
  footer: {
    links: [
      { href: "/guide#setup", label: { en: "Guide", fr: "Guide FR" } },
      { href: "/only-en", label: "Only EN" },
      { href: "https://x.dev", label: "X" },
    ],
  },
});
const links = footer?.links ?? [];

const i18n = {
  defaultLocale: "en",
  hideDefaultLocalePrefix: true,
  locales: [{ code: "en" }, { code: "fr" }],
};
const routes = new Set(["/guide", "/fr/guide", "/only-en"]);

describe(footerLinks, () => {
  it("shows labels in the page's locale and moves served links into it", () => {
    expect(
      footerLinks(links, { basePath: "", i18n, locale: "fr", routes })
    ).toStrictEqual([
      { href: "/fr/guide#setup", label: "Guide FR" },
      // Untranslated, and a URL: as written.
      { href: "/only-en", label: "Only EN" },
      { href: "https://x.dev", label: "X" },
    ]);
  });

  it("falls back to the default locale's label", () => {
    const [guide] = footerLinks(links, {
      basePath: "",
      i18n: { ...i18n, locales: [...i18n.locales, { code: "de" }] },
      locale: "de",
      routes,
    });
    expect(guide).toStrictEqual({ href: "/guide#setup", label: "Guide" });
  });

  it("leaves links alone on a single-locale site", () => {
    const [guide] = footerLinks(links, { basePath: "", i18n: null, routes });
    expect(guide).toStrictEqual({ href: "/guide#setup", label: "Guide" });
  });
});
