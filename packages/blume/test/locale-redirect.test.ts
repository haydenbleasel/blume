import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCALE_STORAGE_KEY,
  rememberLocaleChoice,
} from "../src/components/layout/locale-choice.ts";
import {
  browserLanguageTargets,
  LOCALE_REDIRECT_SCRIPT,
  LOCALE_STORAGE_KEY as REDIRECT_STORAGE_KEY,
  rememberLocaleChoice as redirectRememberLocaleChoice,
} from "../src/components/layout/locale-redirect.ts";
import type { ChoiceTarget } from "../src/components/layout/locale-redirect.ts";
import type { BlumeDataI18n } from "../src/core/data.ts";

/**
 * Routing by browser language: which home pages a visitor on the default
 * home can be sent to, the inline script that sends them, the switcher pick
 * that stops it, and what the switcher ships to the browser to record it.
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
  /** The path the site is served from, as the layout stamps it. */
  base?: string;
  languages?: string[];
  referrer?: string;
  script?: boolean;
  stored?: string | null;
  storageThrows?: boolean;
  /** The client router swapped the page in; the browser didn't load it. */
  swapped?: boolean;
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
              base: options.base,
              default: "en",
              targets:
                options.targets ?? '{"fr":"/docs/fr","pt-br":"/docs/pt-br"}',
            },
          },
    readyState: options.swapped ? "complete" : "loading",
    referrer: options.referrer ?? "",
  };
  // The key is spelled out: the script reads it from the constant, and a
  // changed constant would forget every reader's pick.
  const localStorage = {
    getItem: (key: string) => {
      if (options.storageThrows) {
        throw new Error("blocked");
      }
      return key === "blume-locale" ? (options.stored ?? null) : null;
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

  it("leaves a reader the client router brings to the home page", () => {
    // The referrer still names wherever they first came from.
    expect(
      visit({
        languages: ["fr"],
        referrer: "https://www.google.com/",
        swapped: true,
      })
    ).toBeNull();
    expect(visit({ languages: ["fr"], swapped: true })).toBeNull();
  });

  it("counts the rest of the origin as outside a site served under a base", () => {
    const from = (referrer: string): string | null =>
      visit({ base: "/docs/", languages: ["fr"], referrer });
    expect(from("https://docs.example.com/")).toBe("/docs/fr?a=1#start");
    expect(from("https://docs.example.com/pricing?plan=pro")).toBe(
      "/docs/fr?a=1#start"
    );
    // A sibling path that only starts like the base.
    expect(from("https://docs.example.com/docs-archive/x")).toBe(
      "/docs/fr?a=1#start"
    );
    expect(from("https://docs.example.com/docs")).toBeNull();
    expect(from("https://docs.example.com/docs?from=nav")).toBeNull();
    expect(from("https://docs.example.com/docs/guide")).toBeNull();
    // At the root, another origin that only starts like this one is outside.
    expect(
      visit({
        base: "/",
        languages: ["fr"],
        referrer: "https://docs.example.com.evil.test/",
      })
    ).toBe("/docs/fr?a=1#start");
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

/** How `rememberLocaleChoice` listens on the document. */
type AddListener = ChoiceTarget["addEventListener"];

/** The events `rememberLocaleChoice` listens for. */
type ClickType = Parameters<AddListener>[0];

/** The listener `rememberLocaleChoice` adds. */
type ClickListener = Parameters<AddListener>[1];

/**
 * A document stand-in at `location` that sends an event to the listener it
 * was given for that type.
 */
const listen = (location?: { hash: string }) => {
  const listeners = new Map<ClickType, ClickListener>();
  rememberLocaleChoice({
    addEventListener: (type, handler) => {
      listeners.set(type, handler);
    },
    location: location ?? { hash: "" },
  });
  return (
    event: Parameters<ClickListener>[0],
    type: ClickType = "click"
  ): void => {
    listeners.get(type)?.(event);
  };
};

/** A switcher link for `hreflang`, pointing at `href`. */
const choice = (hreflang: string, href = "/fr/guide") => {
  const attributes = new Map([
    ["hreflang", hreflang],
    ["href", href],
  ]);
  return {
    attributes,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
  };
};

/**
 * A click with a mouse button (the main one unless given) on an element
 * whose switcher link (if any) is `link`.
 */
const click = (link: ReturnType<typeof choice> | null, button = 0) => ({
  button,
  target: { closest: () => link },
});

describe(rememberLocaleChoice, () => {
  it("remembers a language picked with the switcher", () => {
    const { items, local } = storage();
    globalThis.localStorage = local;
    const onClick = listen();
    onClick(click(choice("fr")));
    expect(items.get("blume-locale")).toBe("fr");
  });

  it("remembers a language opened in a new tab with a middle click", () => {
    const { items, local } = storage();
    globalThis.localStorage = local;
    const link = choice("fr");
    const onClick = listen({ hash: "#install" });
    // A right click fires `auxclick` too, and picks nothing.
    onClick(click(link, 2), "auxclick");
    expect(items.size).toBe(0);
    expect(link.attributes.get("href")).toBe("/fr/guide");
    onClick(click(link, 1), "auxclick");
    expect(items.get("blume-locale")).toBe("fr");
    expect(link.attributes.get("href")).toBe("/fr/guide#install");
  });

  it("ignores other clicks, and storage that's off", () => {
    const { items, local } = storage(true);
    globalThis.localStorage = local;
    const onClick = listen();
    onClick(click(null));
    onClick({ button: 0, target: null });
    expect(() => onClick(click(choice("fr")))).not.toThrow();
    expect(items.size).toBe(0);
  });

  it("keeps the reader's place in the chosen language", () => {
    globalThis.localStorage = storage().local;
    const location = { hash: "#install" };
    const link = choice("fr");
    const onClick = listen(location);
    onClick(click(link));
    onClick(click(link));
    expect(link.attributes.get("href")).toBe("/fr/guide#install");
    // Back at the top, the fragment an earlier click left goes.
    location.hash = "";
    onClick(click(link));
    expect(link.attributes.get("href")).toBe("/fr/guide");
  });

  it("listens before the client router reads the link", () => {
    const registered: [ClickType, Parameters<AddListener>[2]][] = [];
    rememberLocaleChoice({
      addEventListener: (type, _handler, given) => {
        registered.push([type, given]);
      },
      location: { hash: "" },
    });
    // The router's bubbling listener on the document is registered first.
    expect(registered).toStrictEqual([
      ["click", { capture: true }],
      ["auxclick", { capture: true }],
    ]);
  });

  it("is still exported from locale-redirect.ts, where it lived", () => {
    expect(redirectRememberLocaleChoice).toBe(rememberLocaleChoice);
    expect(REDIRECT_STORAGE_KEY).toBe(LOCALE_STORAGE_KEY);
  });
});

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const LAYOUT = path.resolve(SRC, "components/layout");
const SWITCHER_SCRIPT = /<script>(?<code>[\s\S]*?)<\/script>/u;
const transpiler = new Bun.Transpiler({ loader: "ts" });

/**
 * Blume's modules in the import graph of `code`, a module in `dir`, as paths
 * under `src/`. The transpiler drops type-only imports, as a bundler does.
 */
const modulesReachedFrom = (code: string, dir: string): string[] => {
  const seen = new Set<string>();
  const walk = (source: string, from: string): void => {
    for (const { path: specifier } of transpiler.scanImports(source)) {
      const file = path.resolve(from, specifier);
      if (specifier.startsWith(".") && !seen.has(file)) {
        seen.add(file);
        if (file.endsWith(".ts")) {
          walk(readFileSync(file, "utf-8"), path.dirname(file));
        }
      }
    }
  };
  walk(code, dir);
  return [...seen].map((file) =>
    path.relative(SRC, file).replaceAll("\\", "/")
  );
};

const isTranslationPack = (module: string): boolean =>
  module.startsWith("core/ui-packs/");

describe("the switcher's browser script", () => {
  it("stays clear of the translation packs", () => {
    const switcher = readFileSync(
      path.resolve(LAYOUT, "LanguageSwitcher.astro"),
      "utf-8"
    );
    const script = SWITCHER_SCRIPT.exec(switcher)?.groups?.code ?? "";
    const modules = modulesReachedFrom(script, LAYOUT);
    expect(modules).toContain("components/layout/locale-choice.ts");
    expect(modules.filter(isTranslationPack)).toStrictEqual([]);
    // The walk does find the packs from the module the pick used to live in,
    // which is what put them in the script.
    const redirect = modulesReachedFrom(
      readFileSync(path.resolve(LAYOUT, "locale-redirect.ts"), "utf-8"),
      LAYOUT
    );
    expect(redirect.some(isTranslationPack)).toBe(true);
  });
});
