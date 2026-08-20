/**
 * A hand-rolled DOM shared by the playground client suites
 * (`playground-client.test.ts`, the AsyncAPI message composer). happy-dom and
 * jsdom would drag a heavy dependency and a real parser into a package whose
 * client modules only ever touch a handful of DOM methods, so instead this
 * models exactly that surface: attributes, a parent/child tree, form state
 * (`value`/`checked`), and listener lists a test fires by hand.
 *
 * Selectors understood by `matches`/`querySelector`/`querySelectorAll`/`closest`
 * are the subset the clients emit: an optional leading tag name followed by any
 * number of ANDed attribute clauses — `[attr]` for presence, `[attr="value"]`
 * for equality, with `\"`/`\\` escapes inside the quoted value (the clients
 * escape spec-derived names before interpolating them). Classes, ids,
 * combinators, and pseudo-selectors are not supported; a client that needs one
 * must grow this helper alongside it.
 */

/** Matches the tag + attribute selector subset the clients use. */
const SELECTOR_CLAUSE =
  /\[(?<name>[^\]=]+)(?:="(?<value>(?:\\.|[^"\\])*)")?\]/gu;

/** Undo the attribute-value escaping a client applied: `\"` -> `"`. */
const unescapeValue = (value: string): string =>
  value.replaceAll(/\\(?<char>.)/gu, "$<char>");

/** Proxy keys arrive as `string | symbol`; only string `data-*` keys exist. */
const isStringKey = (key: string | symbol): key is string =>
  typeof key === "string";

/** The event payload the fake tree hands a client's listener. */
export interface FakeEvent {
  target: unknown;
}

/** A client's handler: sync wiring returns void, the send handler a Promise. */
export type FakeListener = (event: FakeEvent) => void | Promise<void>;

/** Narrow a maybe-undefined fixture handle; a missing element is a test bug. */
export const must = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) {
    throw new Error("expected element");
  }
  return value;
};

/** A minimal element: attributes, tree, form state, listeners. */
export class FakeEl {
  attributes = new Map<string, string>();
  checked = false;
  /** Button state the composer toggles as a connection opens and closes. */
  disabled = false;
  children: FakeEl[] = [];
  className = "";
  listeners = new Map<string, FakeListener[]>();
  parent: FakeEl | null = null;
  tag: string;
  value = "";
  #text = "";

  /** Read-only dataset mirror of `data-*` attributes. */
  dataset: Record<string, string | undefined>;

  constructor(tag = "div", attrs: Record<string, string> = {}, text = "") {
    this.tag = tag;
    for (const [name, value] of Object.entries(attrs)) {
      this.attributes.set(name, value);
    }
    this.#text = text;
    this.dataset = new Proxy(
      {},
      {
        get: (_, prop) =>
          isStringKey(prop)
            ? this.attributes.get(
                `data-${prop.replaceAll(/[A-Z]/gu, (ch) => `-${ch.toLowerCase()}`)}`
              )
            : undefined,
      }
    );
  }

  /** Detach from the tree, so a suite can render a panel without one hook. */
  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter(
        (child) => child !== this
      );
      this.parent = null;
    }
  }

  get textContent(): string {
    return (
      this.#text + this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value: string) {
    this.children = [];
    this.#text = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: FakeEl[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  addEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  matches(selector: string): boolean {
    const [tag] = /^[a-z-]+/u.exec(selector) ?? [];
    if (tag && this.tag !== tag) {
      return false;
    }
    for (const clause of selector.matchAll(SELECTOR_CLAUSE)) {
      const actual = this.attributes.get(clause.groups?.name ?? "");
      const raw = clause.groups?.value;
      const wanted = raw === undefined ? undefined : unescapeValue(raw);
      if (wanted === undefined ? actual === undefined : actual !== wanted) {
        return false;
      }
    }
    return true;
  }

  descendants(): FakeEl[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): FakeEl[] {
    return this.descendants().filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FakeEl | null {
    if (this.matches(selector)) {
      return this;
    }
    return this.parent ? this.parent.closest(selector) : null;
  }
}

export const el = (
  tag: string,
  attrs: Record<string, string> = {},
  text = ""
): FakeEl => new FakeEl(tag, attrs, text);

/**
 * Present a FakeEl to a client entry point that expects a real element.
 * Kept as one helper so the assertion and its justification live in one place.
 */
export const asElement = (fake: FakeEl): HTMLElement =>
  // SAFETY: installFakeDom registers FakeEl as `globalThis.HTMLElement`, so at
  // runtime this instance passes the clients' `instanceof HTMLElement` checks
  // and implements the query/attribute/event surface they read.
  fake as FakeEl & HTMLElement;

/** Invoke `el`'s listeners for `type` as if `target` dispatched the event. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- suites dispatch arbitrary targets (elements, null, plain objects) to exercise the clients' own target guards
export const fire = (host: FakeEl, type: string, target: unknown): unknown[] =>
  [...(host.listeners.get(type) ?? [])].map((listener) => listener({ target }));

/**
 * The map behind the fake `localStorage`, exposed so a suite can seed an entry
 * before init and assert on what a client persisted — cheaper and clearer than
 * reading it back through the storage API.
 */
export const storage = new Map<string, string>();

const fakeStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  removeItem: (key: string) => {
    storage.delete(key);
  },
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
};

const fakeDocument = {
  createElement: (tag: string) => new FakeEl(tag),
  // Fallback scope when no wrapper element (e.g. [data-operation-panel]) is
  // above the root a client was handed.
  querySelectorAll: () => [],
};

export interface FakeDomOptions {
  /**
   * Network stub. Recording and canned responses stay with the suite that cares
   * about requests, so this only handles swapping the global in and out.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** The globals an install swaps in, keyed by the global name each replaces. */
interface FakeGlobals {
  HTMLElement: typeof FakeEl;
  document: typeof fakeDocument;
  fetch?: FakeDomOptions["fetch"];
  localStorage: typeof fakeStorage;
}

/**
 * Install the fake `document`, `localStorage` and `HTMLElement` globals (plus
 * `fetch` when a stub is given) and return the undo. Clients read these off
 * `globalThis` at call time, so a suite installs in `beforeAll` and calls the
 * returned function in `afterAll` to leave the runtime as it found it.
 */
export const installFakeDom = (options: FakeDomOptions = {}): (() => void) => {
  const values: FakeGlobals = {
    HTMLElement: FakeEl,
    document: fakeDocument,
    localStorage: fakeStorage,
  };
  if (options.fetch) {
    values.fetch = options.fetch;
  }
  const saved = new Map(
    Object.keys(values).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ])
  );
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
    // The storage map is module-level, so entries a suite persisted would
    // otherwise leak into the next suite's "fresh" localStorage.
    storage.clear();
  };
};
