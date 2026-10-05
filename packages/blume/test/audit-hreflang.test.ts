import { describe, expect, it } from "bun:test";

import { i18nChecks } from "../src/audit/checks/i18n.ts";
import type { AuditContext } from "../src/audit/types.ts";
import type { Diagnostic } from "../src/core/types.ts";
import { codes, context, manifestRoute, snapshot } from "./audit-support.ts";

/**
 * The hreflang checks against the shapes Blume itself emits: i18n fallback
 * copies, archived versions that canonicalize to the latest docs, and
 * non-ASCII slugs. A plain `blume audit` of Blume's own output must pass.
 */

const SITE = "https://x.dev";

// SAFETY: the i18n checks run synchronously; only the network tiers return a
// promise.
const run = (ctx: AuditContext): string[] =>
  codes(i18nChecks.run(ctx) as Diagnostic[]);

const alternates = (paths: Record<string, string>, xDefault: string) => [
  ...Object.entries(paths).map(([lang, path]) => ({
    href: `${SITE}${path}`,
    lang,
  })),
  { href: `${SITE}${xDefault}`, lang: "x-default" },
];

// `/guide` exists only in English; Blume renders a fallback copy at
// `/fr/guide` whose hreflang names the real translations (English only)
// and whose canonical names the page it copies. The real page never names
// the copy back — by design, it isn't a translation.
const pages = (fallback: boolean) => [
  snapshot({
    hreflang: alternates({ en: "/guide" }, "/guide"),
    url: "/guide",
  }),
  snapshot({
    canonical: `${SITE}/guide`,
    hreflang: alternates({ en: "/guide" }, "/guide"),
    lang: "fr",
    route: manifestRoute({ fallback, locale: "fr", path: "/fr/guide" }),
    url: "/fr/guide",
  }),
];

describe("hreflang on i18n fallback copies", () => {
  it("skips the fallback copy's hreflang cluster", () => {
    expect(run(context({ pages: pages(true), site: SITE }))).toEqual([]);
  });

  it("still checks a real page with the same markup", () => {
    const found = run(context({ pages: pages(false), site: SITE }));
    expect(found).toContain("HREFLANG_SELF_MISSING");
    expect(found).toContain("HREFLANG_NO_RETURN_TAG");
  });
});

const versions = (canonical: "latest" | "self") => ({
  archived: [{ banner: true, canonical, id: "v1", noindex: false }],
  current: { label: "v2" },
});

describe("hreflang on archived versions", () => {
  // Each archived page canonicalizes to its latest equivalent — Blume's
  // default — while its hreflang cluster names the archived translations.
  const archived = [
    snapshot({
      canonical: `${SITE}/`,
      hreflang: alternates({ en: "/v1", fr: "/fr/v1" }, "/v1"),
      route: manifestRoute({
        path: "/v1",
        version: "v1",
        versionAlternates: [
          { path: "/", version: "" },
          { path: "/v1", version: "v1" },
        ],
      }),
      url: "/v1",
    }),
    snapshot({
      canonical: `${SITE}/fr`,
      hreflang: alternates({ en: "/v1", fr: "/fr/v1" }, "/v1"),
      lang: "fr",
      route: manifestRoute({
        locale: "fr",
        path: "/fr/v1",
        version: "v1",
        versionAlternates: [
          { path: "/fr", version: "" },
          { path: "/fr/v1", version: "v1" },
        ],
      }),
      url: "/fr/v1",
    }),
  ];

  it("accepts targets that canonicalize to their latest equivalent", () => {
    const ctx = context({
      pages: archived,
      site: SITE,
      versions: versions("latest"),
    });
    expect(run(ctx)).toEqual([]);
  });

  it("still reports a target that canonicalizes anywhere else", () => {
    // `canonical: "self"` means Blume would not have pointed these at the
    // latest docs, so the canonical is not its own default.
    const ctx = context({
      pages: archived,
      site: SITE,
      versions: versions("self"),
    });
    expect(run(ctx)).toContain("HREFLANG_BAD_TARGET");
  });

  it("still reports a target whose canonical is not a URL", () => {
    const ctx = context({
      pages: [
        snapshot({
          hreflang: alternates({ en: "/", fr: "/fr" }, "/"),
          url: "/",
        }),
        snapshot({
          canonical: "not a url",
          hreflang: alternates({ en: "/", fr: "/fr" }, "/"),
          lang: "fr",
          url: "/fr",
        }),
      ],
      site: SITE,
    });
    expect(run(ctx)).toContain("HREFLANG_BAD_TARGET");
  });
});

describe("hreflang on non-ASCII slugs", () => {
  it("matches percent-encoded hrefs against raw page URLs", () => {
    // Page URLs come from the file tree (`/ガイド`); hreflang hrefs are
    // `encodeURI`'d, as every URL Blume emits is.
    const hreflang = [
      { href: encodeURI(`${SITE}/ガイド`), lang: "en" },
      { href: encodeURI(`${SITE}/fr/ガイド`), lang: "fr" },
      { href: encodeURI(`${SITE}/ガイド`), lang: "x-default" },
    ];
    const ctx = context({
      pages: [
        snapshot({
          canonical: encodeURI(`${SITE}/ガイド`),
          hreflang,
          url: "/ガイド",
        }),
        snapshot({
          canonical: encodeURI(`${SITE}/fr/ガイド`),
          hreflang,
          lang: "fr",
          url: "/fr/ガイド",
        }),
      ],
      site: SITE,
    });
    expect(run(ctx)).toEqual([]);
  });
});
