import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONSENT_STORAGE_KEY,
  start as startNative,
  storedChoice,
} from "../src/components/layout/consent/native.ts";
import type { BlumeConsent } from "../src/components/layout/consent/types.ts";
import { HELD_SCRIPTS, startConsent } from "../src/consent/client.ts";
import { ETHYCA_BRIDGE } from "../src/consent/ethyca.ts";
import { CONSENT_INIT_SCRIPT } from "../src/consent/init.ts";
import { OSANO_BRIDGE } from "../src/consent/osano.ts";

// A hand-rolled DOM for the consent runtime (see fake-dom.ts for why not
// happy-dom): elements with attributes, a tree, `hidden`, `after`, and click
// listeners, and a matcher for the `tag[attr]`/`[attr="value"]` selectors the
// runtime uses.

const CLAUSE = /\[(?<name>[^\]=]+)(?:="(?<value>[^"]*)")?\]/gu;

type Listener = (event: { target: FakeNode | null }) => void;

/** What the runtime reads off `element.dataset`. */
interface FakeDataset {
  blumeConsentChoice?: string;
}

/** An inline script's tag, as `document.currentScript`. */
interface FakeScript {
  dataset: Record<string, string>;
}

/** The fake `window`: the consent state and the managers' globals. */
interface FakeWindow {
  blumeConsent?: BlumeConsent;
  webAnalyticsBeforeSend?: (event: string) => string | null;
  Osano?: { cm: FakeOsano };
  Fides?: FakeFides;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
}

interface FakeOsano {
  analytics: boolean;
  events: Map<string, () => void>;
  addEventListener: (type: string, listener: () => void) => void;
  showDrawer: () => void;
}

interface FakeFides {
  consent: Record<string, boolean | string>;
  initialized: boolean;
  showModal: () => void;
}

/** The page's held analytics tags. */
interface HeldPage {
  init: FakeNode;
  loader: FakeNode;
}

/** Scripts the runtime created, in order. */
let inserted: FakeNode[] = [];
let documentListeners = new Map<string, Listener[]>();
let windowListeners = new Map<string, ((event: Event) => void)[]>();
let stored = new Map<string, string>();
let storageBlocked = false;
let reloads = 0;
let fakeWindow: FakeWindow = { addEventListener: () => {} };
/** The fake `document`'s `currentScript`, set per inline run. */
let currentScript: FakeScript | null = null;

class FakeNode {
  async = true;
  children: FakeNode[] = [];
  hidden = false;
  listeners = new Map<string, Listener[]>();
  parent: FakeNode | null = null;
  text = "";
  readonly attrs = new Map<string, string>();
  readonly body: string;
  readonly tag: string;

  constructor(tag: string, attrs: Record<string, string> = {}, body = "") {
    this.tag = tag;
    this.body = body;
    for (const [name, value] of Object.entries(attrs)) {
      this.attrs.set(name, value);
    }
  }

  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }

  get dataset(): FakeDataset {
    return {
      blumeConsentChoice: this.attrs.get("data-blume-consent-choice"),
    };
  }

  get outerHTML(): string {
    const attrs = [...this.attrs].map(([name, value]) => ` ${name}="${value}"`);
    return `<${this.tag}${attrs.join("")}>${this.body}</${this.tag}>`;
  }

  get textContent(): string {
    return this.body;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  append(...nodes: FakeNode[]): FakeNode {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    return this;
  }

  after(node: FakeNode): void {
    const siblings = this.parent?.children ?? [];
    node.parent = this.parent;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
    inserted.push(node);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ target: this });
    }
  }

  matches(selector: string): boolean {
    const [tag] = /^[a-z]+/u.exec(selector) ?? [];
    if (tag && tag !== this.tag) {
      return false;
    }
    return [...selector.matchAll(CLAUSE)].every(({ groups }) => {
      const actual = this.attrs.get(groups?.name ?? "");
      return groups?.value === undefined
        ? actual !== undefined
        : actual === groups.value;
    });
  }

  descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.descendants().filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FakeNode | null {
    if (this.matches(selector)) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }
}

let root = new FakeNode("html");

const fireDocument = (type: string, target: FakeNode | null = null): void => {
  for (const listener of documentListeners.get(type) ?? []) {
    listener({ target });
  }
};

const fireWindow = (event: Event): boolean => {
  for (const listener of windowListeners.get(event.type) ?? []) {
    listener(event);
  }
  return true;
};

const blockedError = () =>
  new Error("SecurityError: The operation is insecure.");

beforeEach(() => {
  inserted = [];
  root = new FakeNode("html");
  documentListeners = new Map();
  windowListeners = new Map();
  stored = new Map();
  storageBlocked = false;
  reloads = 0;
  fakeWindow = {
    addEventListener: (type, listener) => {
      windowListeners.set(type, [
        ...(windowListeners.get(type) ?? []),
        listener,
      ]);
    },
  };
  Object.assign(globalThis, {
    Element: FakeNode,
    addEventListener: fakeWindow.addEventListener,
    dispatchEvent: fireWindow,
    document: {
      addEventListener: (type: string, listener: Listener) => {
        documentListeners.set(type, [
          ...(documentListeners.get(type) ?? []),
          listener,
        ]);
      },
      createElement: (tag: string) => new FakeNode(tag),
      get currentScript() {
        return currentScript;
      },
      querySelector: (selector: string) => root.querySelector(selector),
      querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    },
    localStorage: {
      getItem: (key: string) => {
        if (storageBlocked) {
          throw blockedError();
        }
        return stored.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageBlocked) {
          throw blockedError();
        }
        stored.set(key, value);
      },
    },
    location: {
      reload: () => {
        reloads += 1;
      },
    },
    window: fakeWindow,
  });
});

afterEach(() => {
  for (const name of [
    "Element",
    "addEventListener",
    "dispatchEvent",
    "document",
    "localStorage",
    "location",
    "window",
  ]) {
    Reflect.deleteProperty(globalThis, name);
  }
});

let runs = 0;

/**
 * Run an inline script the way a browser runs `<script is:inline>`: against
 * the fake globals, as a throwaway module (a fresh file per run, since module
 * evaluation is cached). `dataset` stands in for the tag's `data-*`.
 */
const runInline = async (
  source: string,
  dataset: Record<string, string> = {}
): Promise<void> => {
  currentScript = { dataset };
  const dir = await mkdtemp(path.join(tmpdir(), "blume-consent-"));
  runs += 1;
  const file = path.join(dir, `inline-${runs}.js`);
  await writeFile(file, source);
  await import(file);
};

/** The page's held analytics: an external loader and an inline init. */
const heldPage = (): HeldPage => {
  const loader = new FakeNode("script", {
    async: "",
    "data-blume-consent": "analytics",
    src: "https://example.com/a.js",
    type: "text/plain",
  });
  const init = new FakeNode(
    "script",
    { "data-blume-consent": "analytics", type: "text/plain" },
    "init()"
  );
  root.append(new FakeNode("head").append(loader, init));
  return { init, loader };
};

/** The native banner, as `ConsentBanner.astro` renders it. */
const bannerPage = () => {
  const accept = new FakeNode("button", {
    "data-blume-consent-choice": "accept",
  });
  const decline = new FakeNode("button", {
    "data-blume-consent-choice": "decline",
  });
  const banner = new FakeNode("div", { "data-blume-consent-banner": "" });
  banner.hidden = true;
  banner.append(accept, decline);
  const settings = new FakeNode("button", { "data-blume-consent-open": "" });
  root.append(new FakeNode("body").append(banner, settings));
  return { accept, banner, decline, settings };
};

const consent = (): BlumeConsent => {
  const state = fakeWindow.blumeConsent;
  if (!state) {
    throw new Error("the init script did not run");
  }
  return state;
};

describe("CONSENT_INIT_SCRIPT", () => {
  it("creates the consent state, and fires blume:consent on each change", async () => {
    const seen: boolean[] = [];
    fakeWindow.addEventListener("blume:consent", (event) => {
      // SAFETY: the init script dispatches a CustomEvent with this detail.
      seen.push(
        (event as CustomEvent<{ analytics: boolean }>).detail.analytics
      );
    });
    await runInline(CONSENT_INIT_SCRIPT, { kind: "osano" });
    const state = consent();
    expect(state.kind).toBe("osano");
    expect(state.analytics).toBeNull();
    state.set({ analytics: false });
    state.set({ analytics: false });
    state.set({ analytics: true });
    expect(seen).toStrictEqual([false, true]);
  });

  it("holds Vercel's events until analytics is allowed", async () => {
    await runInline(CONSENT_INIT_SCRIPT);
    const gate = fakeWindow.webAnalyticsBeforeSend;
    expect(consent().kind).toBe("");
    expect(gate?.("pageview")).toBeNull();
    consent().set({ analytics: true });
    expect(gate?.("pageview")).toBe("pageview");
  });

  it("keeps the state it already made", async () => {
    await runInline(CONSENT_INIT_SCRIPT, { kind: "native" });
    const first = consent();
    await runInline(CONSENT_INIT_SCRIPT, { kind: "osano" });
    expect(consent()).toBe(first);
  });
});

describe(startConsent, () => {
  it("does nothing without the init script's state", () => {
    let started = false;
    startConsent(() => {
      started = true;
    });
    expect(started).toBe(false);
    expect(documentListeners.size).toBe(0);
    expect(windowListeners.size).toBe(0);
  });

  it("starts the adapter's browser module once it's listening", async () => {
    heldPage();
    await runInline(CONSENT_INIT_SCRIPT, { kind: "custom" });
    // A module that reports a returning reader's answer as it starts: the
    // runtime is already listening, so the held analytics run.
    startConsent((state) => {
      state.set({ analytics: true });
    });
    expect(inserted).toHaveLength(2);
  });

  it("asks a new reader, and runs the analytics once they accept", async () => {
    const { init, loader } = heldPage();
    const { accept, banner } = bannerPage();
    await runInline(CONSENT_INIT_SCRIPT, { kind: "native" });
    startConsent((state) => startNative(state, {}));
    expect(banner.hidden).toBe(false);
    expect(consent().analytics).toBe(false);
    expect(inserted).toHaveLength(0);

    accept.click();
    expect(banner.hidden).toBe(true);
    expect(stored.get(CONSENT_STORAGE_KEY)).toBe("granted");
    expect(inserted).toHaveLength(2);
    const [runLoader, runInit] = inserted;
    expect(runLoader?.attrs).toStrictEqual(
      new Map([
        ["async", ""],
        ["src", "https://example.com/a.js"],
      ])
    );
    // An async tag stays async; the rest keep document order.
    expect(runLoader?.async).toBe(true);
    expect(runInit?.async).toBe(false);
    expect(runInit?.text).toBe("init()");
    // Each runs right after the tag it came from.
    expect(loader.parent?.children).toStrictEqual([
      loader,
      ...inserted.slice(0, 1),
      init,
      ...inserted.slice(1),
    ]);
  });

  it("runs a returning reader's analytics once per page load", async () => {
    stored.set(CONSENT_STORAGE_KEY, "granted");
    heldPage();
    const { banner } = bannerPage();
    await runInline(CONSENT_INIT_SCRIPT, { kind: "native" });
    startConsent((state) => startNative(state, {}));
    expect(banner.hidden).toBe(true);
    expect(inserted).toHaveLength(2);

    // A navigation brings back the same held tags and a fresh banner.
    root = new FakeNode("html");
    heldPage();
    const next = bannerPage();
    fireDocument("astro:after-swap");
    expect(inserted).toHaveLength(2);
    expect(next.banner.hidden).toBe(true);
  });

  it("reloads when a reader takes consent back after the analytics ran", async () => {
    stored.set(CONSENT_STORAGE_KEY, "granted");
    heldPage();
    const { banner, decline, settings } = bannerPage();
    await runInline(CONSENT_INIT_SCRIPT, { kind: "native" });
    startConsent((state) => startNative(state, {}));

    fireDocument("click", settings);
    expect(banner.hidden).toBe(false);
    decline.click();
    expect(stored.get(CONSENT_STORAGE_KEY)).toBe("denied");
    expect(reloads).toBe(1);
  });

  it("declines without a reload when nothing ran", async () => {
    heldPage();
    const { decline } = bannerPage();
    await runInline(CONSENT_INIT_SCRIPT, { kind: "native" });
    startConsent((state) => startNative(state, {}));
    decline.click();
    expect(consent().analytics).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(reloads).toBe(0);
  });

  it("asks on every page, and still runs the analytics, when storage is blocked", async () => {
    storageBlocked = true;
    heldPage();
    const { accept, banner } = bannerPage();
    await runInline(CONSENT_INIT_SCRIPT, { kind: "native" });
    startConsent((state) => startNative(state, {}));
    expect(banner.hidden).toBe(false);
    accept.click();
    expect(inserted).toHaveLength(2);
  });

  it("gets by on a page without the banner", async () => {
    await runInline(CONSENT_INIT_SCRIPT, { kind: "native" });
    startConsent((state) => startNative(state, {}));
    consent().open?.();
    fireDocument("astro:after-swap");
    expect(consent().analytics).toBe(false);
  });

  it("follows a hosted manager's answers and reopens it", async () => {
    heldPage();
    const { settings } = bannerPage();
    let opened = 0;
    await runInline(CONSENT_INIT_SCRIPT, { kind: "osano" });
    consent().open = () => {
      opened += 1;
    };
    startConsent();
    expect(inserted).toHaveLength(0);

    consent().set({ analytics: true });
    expect(inserted).toHaveLength(2);
    fireDocument("astro:after-swap");
    expect(inserted).toHaveLength(2);

    fireDocument("click", settings);
    fireDocument("click", new FakeNode("a"));
    fireDocument("click", null);
    expect(opened).toBe(1);
  });

  it("runs analytics a manager allowed before the runtime started", async () => {
    heldPage();
    await runInline(CONSENT_INIT_SCRIPT, { kind: "osano" });
    consent().set({ analytics: true });
    startConsent();
    expect(inserted).toHaveLength(2);
  });
});

describe(storedChoice, () => {
  it("reads only the two answers the banner stores", () => {
    expect(storedChoice()).toBeNull();
    stored.set(CONSENT_STORAGE_KEY, "denied");
    expect(storedChoice()).toBe(false);
    stored.set(CONSENT_STORAGE_KEY, "maybe");
    expect(storedChoice()).toBeNull();
  });
});

describe("HELD_SCRIPTS", () => {
  it("matches only the held analytics tags", () => {
    const held = new FakeNode("script", {
      "data-blume-consent": "analytics",
      type: "text/plain",
    });
    expect(held.matches(HELD_SCRIPTS)).toBe(true);
    expect(
      new FakeNode("script", { type: "text/plain" }).matches(HELD_SCRIPTS)
    ).toBe(false);
  });
});

/** Osano's `Osano.cm`, recording the listeners the bridge adds. */
const fakeOsano = (analytics: boolean): FakeOsano => {
  const events = new Map<string, () => void>();
  return {
    addEventListener: (type, listener) => {
      events.set(type, listener);
    },
    analytics,
    events,
    showDrawer: () => {
      events.set("drawer", () => {});
    },
  };
};

describe("OSANO_BRIDGE", () => {
  it("reports Osano's analytics consent now and on every change", async () => {
    await runInline(CONSENT_INIT_SCRIPT, { kind: "osano" });
    const cm = fakeOsano(false);
    fakeWindow.Osano = { cm };
    await runInline(OSANO_BRIDGE);
    expect(consent().analytics).toBe(false);
    expect([...cm.events.keys()]).toStrictEqual([
      "osano-cm-initialized",
      "osano-cm-consent-saved",
      "osano-cm-consent-changed",
    ]);
    cm.analytics = true;
    cm.events.get("osano-cm-consent-saved")?.();
    expect(consent().analytics).toBe(true);
    consent().open?.();
    expect(cm.events.has("drawer")).toBe(true);
  });

  it("stays out of the way when Osano didn't load", async () => {
    await runInline(CONSENT_INIT_SCRIPT, { kind: "osano" });
    await runInline(OSANO_BRIDGE);
    expect(consent().analytics).toBeNull();
    expect(consent().open).toBeUndefined();
  });
});

const fides = (consentValues: Record<string, boolean | string>) => {
  let modals = 0;
  const value: FakeFides = {
    consent: consentValues,
    initialized: true,
    showModal: () => {
      modals += 1;
    },
  };
  return { modals: () => modals, value };
};

describe("ETHYCA_BRIDGE", () => {
  it("reads the analytics notice when Fides is ready and on every update", async () => {
    await runInline(CONSENT_INIT_SCRIPT, { kind: "ethyca" });
    const loaded = fides({ analytics: "opt_in" });
    fakeWindow.Fides = loaded.value;
    await runInline(ETHYCA_BRIDGE, { notice: "analytics" });
    expect(consent().analytics).toBe(true);

    fireWindow(
      new CustomEvent("FidesUpdated", {
        detail: { consent: { analytics: false } },
      })
    );
    expect(consent().analytics).toBe(false);
    fireWindow(
      new CustomEvent("FidesReady", {
        detail: { consent: { analytics: "acknowledge" } },
      })
    );
    expect(consent().analytics).toBe(true);
    consent().open?.();
    expect(loaded.modals()).toBe(1);
  });

  it("reads a custom notice key, and waits for Fides to be ready", async () => {
    await runInline(CONSENT_INIT_SCRIPT, { kind: "ethyca" });
    await runInline(ETHYCA_BRIDGE, { notice: "measurement" });
    expect(consent().analytics).toBeNull();
    fireWindow(new CustomEvent("FidesReady"));
    expect(consent().analytics).toBe(false);
    fakeWindow.Fides = fides({ measurement: true }).value;
    fireWindow(new CustomEvent("FidesUpdated"));
    expect(consent().analytics).toBe(true);
  });

  it("does nothing without the consent state", async () => {
    await runInline(ETHYCA_BRIDGE);
    expect(fakeWindow.blumeConsent).toBeUndefined();
  });
});
