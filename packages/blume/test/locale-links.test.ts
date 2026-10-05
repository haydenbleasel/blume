import { describe, expect, it } from "bun:test";

import {
  localizeContentLinks,
  localizeHref,
  localizeLinkPath,
  routeSetFor,
} from "../src/core/locale-links.ts";

const i18n = {
  defaultLocale: "en",
  hideDefaultLocalePrefix: true,
  locales: [{ code: "en" }, { code: "fr" }, { code: "de" }],
};

const routes = new Set([
  "/",
  "/guide",
  "/guide/setup",
  "/café",
  "/fr",
  "/fr/guide",
  "/fr/café",
  "/de/guide",
  "/pricing",
]);

const fr = { basePath: "", i18n, locale: "fr", routes };

describe(localizeLinkPath, () => {
  it("moves a default-locale link into the page locale when that route is served", () => {
    expect(localizeLinkPath("/guide", fr)).toBe("/fr/guide");
    expect(localizeLinkPath("/", fr)).toBe("/fr");
    expect(localizeLinkPath("/guide/", fr)).toBe("/fr/guide");
  });

  it("keeps a link whose locale variant is not served", () => {
    // A custom page, a generated route, or a missing translation with
    // fallbacks disabled — the authored target beats a 404.
    expect(localizeLinkPath("/pricing", fr)).toBe("/pricing");
    expect(localizeLinkPath("/guide/setup", fr)).toBe("/guide/setup");
  });

  it("never re-prefixes a link already under a locale", () => {
    expect(localizeLinkPath("/fr/guide", fr)).toBe("/fr/guide");
    expect(localizeLinkPath("/fr", fr)).toBe("/fr");
    // An explicit cross-locale link is intentional.
    expect(localizeLinkPath("/de/guide", fr)).toBe("/de/guide");
  });

  it("is a no-op on the hidden default locale", () => {
    expect(localizeLinkPath("/guide", { ...fr, locale: "en" })).toBe("/guide");
  });

  it("prefixes the default locale when its prefix is shown", () => {
    const shown = { ...i18n, hideDefaultLocalePrefix: false };
    const served = new Set(["/en/guide", "/fr/guide"]);
    expect(
      localizeLinkPath("/guide", {
        ...fr,
        i18n: shown,
        locale: "en",
        routes: served,
      })
    ).toBe("/en/guide");
    // `/en/…` now counts as a locale prefix too.
    expect(
      localizeLinkPath("/en/guide", { ...fr, i18n: shown, routes: served })
    ).toBe("/en/guide");
  });

  it("looks routes up decoded but emits the authored encoding", () => {
    expect(localizeLinkPath("/caf%C3%A9", fr)).toBe("/fr/caf%C3%A9");
    expect(localizeLinkPath("/caf%E9", fr)).toBe("/caf%E9");
  });

  it("keeps the site-wide basePath outside the locale prefix", () => {
    const based = {
      ...fr,
      basePath: "/docs",
      routes: new Set(["/docs", "/docs/guide", "/docs/fr", "/docs/fr/guide"]),
    };
    expect(localizeLinkPath("/docs/guide", based)).toBe("/docs/fr/guide");
    expect(localizeLinkPath("/docs", based)).toBe("/docs/fr");
    expect(localizeLinkPath("/docs/fr/guide", based)).toBe("/docs/fr/guide");
  });
});

describe(localizeHref, () => {
  const options = { ...fr, deployBase: "" };

  it("passes external, relative, fragment-only, and asset links through", () => {
    for (const href of [
      "https://example.com/guide",
      "//cdn.example.com/x",
      "./setup",
      "#intro",
      "mailto:a@b.c",
      "/spec.pdf",
      "/guide.md",
      "/logo.svg#icon",
    ]) {
      expect(localizeHref(href, options)).toBe(href);
    }
  });

  it("localizes the path and keeps the query and fragment", () => {
    expect(localizeHref("/guide#setup", options)).toBe("/fr/guide#setup");
    expect(localizeHref("/guide?tab=cli#setup", options)).toBe(
      "/fr/guide?tab=cli#setup"
    );
    expect(localizeHref("/pricing#plans", options)).toBe("/pricing#plans");
  });

  it("layers deployment.base around the localized path", () => {
    const deployed = { ...options, deployBase: "/base" };
    expect(localizeHref("/base/guide", deployed)).toBe("/base/fr/guide");
    expect(localizeHref("/base/pricing", deployed)).toBe("/base/pricing");
  });
});

const rewrite = (href: string) => localizeHref(href, { ...fr, deployBase: "" });

describe(localizeContentLinks, () => {
  it("rewrites every anchor href, whichever quote style and attribute order", () => {
    const html = [
      '<p><a href="/guide">Guide</a> and <a class="x" href="/guide/setup" target="_blank">Setup</a></p>',
      "<a href='/guide#intro'>Intro</a>",
      '<a href="https://example.com">Out</a>',
    ].join("");
    expect(localizeContentLinks(html, rewrite)).toBe(
      [
        '<p><a href="/fr/guide">Guide</a> and <a class="x" href="/guide/setup" target="_blank">Setup</a></p>',
        "<a href='/fr/guide#intro'>Intro</a>",
        '<a href="https://example.com">Out</a>',
      ].join("")
    );
  });

  it("leaves anchors without an href, other tags, and escaped code alone", () => {
    const html = [
      '<a name="top">Top</a>',
      '<abbr title="/guide">G</abbr>',
      '<astro-island props="{&quot;href&quot;:&quot;/guide&quot;}"></astro-island>',
      '<pre><code>&lt;a href="/guide"&gt;</code></pre>',
      '<img src="/guide.png">',
    ].join("");
    expect(localizeContentLinks(html, rewrite)).toBe(html);
  });
});

describe(routeSetFor, () => {
  it("builds one Set per routes array and reuses it", () => {
    const list = [{ path: "/" }, { path: "/fr" }];
    const first = routeSetFor(list);
    expect([...first]).toStrictEqual(["/", "/fr"]);
    expect(routeSetFor(list)).toBe(first);
    expect(routeSetFor([{ path: "/" }])).not.toBe(first);
  });
});
