import { afterEach, describe, expect, it } from "bun:test";

import {
  browserLanguageTargets,
  LOCALE_REDIRECT_SCRIPT,
  LOCALE_STORAGE_KEY,
  rememberLocaleChoice,
} from "../src/components/layout/locale-redirect.ts";
import type { BlumeDataI18n } from "../src/core/data.ts";

/**
 * Routing by browser language: which home pages a visitor on the default
 * home can be sent to, the inline script that sends them, and the switcher
 * pick that stops it.
 */

const i18n = (over: Partial<BlumeDataI18n> = {}): BlumeDataI18n => ({
  defaultLocale: "en",
  fallbackLocale: "en",
  hideDefaultLocalePrefix: true,
  locales: [
    { code: "en", dir: "ltr", label: "English" },
    { code: "fr", dir: "ltr", label: "Français" },
    { code: "pt-br", dir: "ltr", label: "Português" },
    { code: "ja", dir: "ltr", label: "日本語" },
  ],
  routeByBrowserLanguage: true,
  ...over,
});

const routes = new Set(["/docs", "/docs/fr", "/docs/pt-br", "/en", "/fr"]);

describe(browserLanguageTargets, () => {
  it("lists the other languages' served home pages from the default home", () => {
    expect(
      browserLanguageTargets({
        basePath: "/docs",
        i18n: i18n(),
        route: "/docs",
        routes,
      })
    ).toStrictEqual({ fr: "/docs/fr", "pt-br": "/docs/pt-br" });
    // The default home carries its prefix when it isn't hidden.
    expect(
      browserLanguageTargets({
        basePath: "",
        i18n: i18n({ hideDefaultLocalePrefix: false }),
        route: "/en",
        routes,
      })
    ).toStrictEqual({ fr: "/fr" });
  });

  it("routes nowhere when off, away from the default home, or with no other home", () => {
    const context = { basePath: "/docs", route: "/docs", routes };
    expect(
      browserLanguageTargets({
        ...context,
        i18n: i18n({ routeByBrowserLanguage: false }),
      })
    ).toBeNull();
    expect(browserLanguageTargets({ ...context, i18n: null })).toBeNull();
    expect(
      browserLanguageTargets({ ...context, i18n: i18n(), route: "/docs/fr" })
    ).toBeNull();
    expect(
      browserLanguageTargets({ ...context, i18n: i18n(), routes: new Set() })
    ).toBeNull();
  });
});

interface Visit {
  languages?: string[];
  referrer?: string;
  script?: boolean;
  stored?: string | null;
  storageThrows?: boolean;
  targets?: string;
}

/** Run the inline script for a visit, returning where it sent the visitor. */
const visit = (options: Visit): string | null => {
  let sent: string | null = null;
  const document = {
    currentScript:
      options.script === false
        ? null
        : {
            dataset: {
              default: "en",
              targets:
                options.targets ?? '{"fr":"/docs/fr","pt-br":"/docs/pt-br"}',
            },
          },
    referrer: options.referrer ?? "",
  };
  const localStorage = {
    getItem: () => {
      if (options.storageThrows) {
        throw new Error("blocked");
      }
      return options.stored ?? null;
    },
  };
  const location = {
    hash: "#start",
    origin: "https://docs.example.com",
    replace: (url: string) => {
      sent = url;
    },
    search: "?a=1",
  };
  const navigator = { languages: options.languages };
  // oxlint-disable-next-line no-new-func -- runs the inline script as the page would
  new Function(
    "document",
    "localStorage",
    "location",
    "navigator",
    LOCALE_REDIRECT_SCRIPT
  )(document, localStorage, location, navigator);
  return sent;
};

describe("the browser-language script", () => {
  it("sends a visitor to their first preferred language the site has", () => {
    expect(visit({ languages: ["fr-CA", "en"] })).toBe("/docs/fr?a=1#start");
    expect(visit({ languages: ["de", "PT-BR"] })).toBe("/docs/pt-br?a=1#start");
    // A base language finds a regional locale.
    expect(visit({ languages: ["pt"] })).toBe("/docs/pt-br?a=1#start");
  });

  it("keeps a visitor who prefers the default, or nothing the site has", () => {
    expect(visit({ languages: ["en-GB", "fr"] })).toBeNull();
    expect(visit({ languages: ["de"] })).toBeNull();
    expect(visit({})).toBeNull();
  });

  it("stays put for a pick, a visit from the site, or a page it can't read", () => {
    expect(visit({ languages: ["fr"], stored: "en" })).toBeNull();
    expect(visit({ languages: ["fr"], storageThrows: true })).toBeNull();
    expect(
      visit({ languages: ["fr"], referrer: "https://docs.example.com/docs/x" })
    ).toBe(null);
    expect(
      visit({ languages: ["fr"], referrer: "https://www.google.com/" })
    ).toBe("/docs/fr?a=1#start");
    expect(visit({ languages: ["fr"], targets: "not json" })).toBeNull();
    expect(visit({ languages: ["fr"], script: false })).toBeNull();
  });
});

/** A `localStorage` stand-in, as the browser's would be. */
const storage = (throws = false) => {
  const items = new Map<string, string>();
  const local: Storage = {
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (throws) {
        throw new Error("blocked");
      }
      items.set(key, value);
    },
  };
  return { items, local };
};

const realStorage = globalThis.localStorage;

afterEach(() => {
  globalThis.localStorage = realStorage;
});

/** The listener `rememberLocaleChoice` adds. */
type ClickListener = Parameters<
  Parameters<typeof rememberLocaleChoice>[0]["addEventListener"]
>[1];

/** A document stand-in that hands back the click listeners it was given. */
const listen = () => {
  const listeners: ClickListener[] = [];
  rememberLocaleChoice({
    addEventListener: (_type, handler) => {
      listeners.push(handler);
    },
  });
  return (event: Parameters<ClickListener>[0]) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
};

/** A click on an element whose switcher link (if any) is `hreflang`. */
const click = (hreflang: string | null) => ({
  target: {
    closest: () =>
      hreflang === null ? null : { getAttribute: () => hreflang },
  },
});

describe(rememberLocaleChoice, () => {
  it("remembers a language picked with the switcher", () => {
    const { items, local } = storage();
    globalThis.localStorage = local;
    const onClick = listen();
    onClick(click("fr"));
    expect(items.get(LOCALE_STORAGE_KEY)).toBe("fr");
  });

  it("ignores other clicks, and storage that's off", () => {
    const { items, local } = storage(true);
    globalThis.localStorage = local;
    const onClick = listen();
    onClick(click(null));
    onClick({ target: null });
    expect(() => onClick(click("fr"))).not.toThrow();
    expect(items.size).toBe(0);
  });
});
