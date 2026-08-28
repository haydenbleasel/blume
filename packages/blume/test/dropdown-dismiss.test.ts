import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

/**
 * Tests for the shared `<details>` dropdown light-dismiss
 * (`src/components/dropdown-dismiss.ts`). Browser globals are faked the way
 * copy-feedback.test.ts fakes them — a hand-rolled tree with just the surface
 * the module reads (`contains`, `closest("dialog")`, `open`, `focus`) — and
 * restored afterwards so later test files see the environment they expect.
 */

/** A minimal element: tag, attributes, tree, `<details>` open state, focus. */
class FakeEl {
  attributes = new Set<string>();
  children: FakeEl[] = [];
  focused = false;
  open = false;
  parent: FakeEl | null = null;
  tag: string;

  constructor(tag: string, ...attributes: string[]) {
    this.tag = tag;
    for (const name of attributes) {
      this.attributes.add(name);
    }
  }

  append(...nodes: FakeEl[]): this {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    return this;
  }

  descendants(): FakeEl[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  contains(node: FakeEl): boolean {
    return node === this || this.descendants().includes(node);
  }

  closest(tag: string): FakeEl | null {
    if (this.tag === tag) {
      return this;
    }
    return this.parent?.closest(tag) ?? null;
  }

  /**
   * Tag plus ANDed presence clauses, the shape of the selectors the module
   * issues. `[open]` reads the live `open` state so the fixture answers the
   * real `details[data-blume-dropdown][open]` — and would answer a regressed
   * `details[open]` with the plain collapsible that precedes the dropdowns.
   */
  matches(selector: string): boolean {
    const [tag] = /^[a-z-]+/u.exec(selector) ?? [];
    if (tag && this.tag !== tag) {
      return false;
    }
    for (const clause of selector.matchAll(/\[(?<name>[^\]]+)\]/gu)) {
      const name = clause.groups?.name ?? "";
      const present = name === "open" ? this.open : this.attributes.has(name);
      if (!present) {
        return false;
      }
    }
    return true;
  }

  querySelectorAll(selector: string): FakeEl[] {
    return this.descendants().filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus(): void {
    this.focused = true;
  }
}

/** The subset of the pointer / keyboard / focus event surface the module reads. */
interface FakeEvent {
  isComposing?: boolean;
  key?: string;
  relatedTarget?: FakeEl | null;
  target?: FakeEl | null;
}

type Listener = (event: FakeEvent) => void;

/** Every registration kept, so a duplicate `addEventListener` is visible. */
const documentListeners = new Map<string, Listener[]>();
const windowListeners = new Map<string, Listener[]>();

const register =
  (store: Map<string, Listener[]>) => (type: string, listener: Listener) => {
    store.set(type, [...(store.get(type) ?? []), listener]);
  };

// The tree, in DOM order:
//   body > dialog > input
//        > article > collapsible(details[open]) > a
//        > header(details[data-blume-dropdown]) > summary, div > a
//        > actions(details[data-blume-dropdown]) > summary, div > button
const body = new FakeEl("body");
const dialog = new FakeEl("dialog");
const searchInput = new FakeEl("input");
dialog.append(searchInput);
const article = new FakeEl("article");
// A plain open <details> (a collapsible in the article) precedes the dropdowns
// so a lookup that dropped the `data-blume-dropdown` clause would find it.
const collapsible = new FakeEl("details");
collapsible.open = true;
const link = new FakeEl("a");
article.append(collapsible, link);
const header = new FakeEl("details", "data-blume-dropdown");
const headerSummary = new FakeEl("summary");
const headerItem = new FakeEl("a");
header.append(headerSummary, new FakeEl("div").append(headerItem));
const actions = new FakeEl("details", "data-blume-dropdown");
const actionsSummary = new FakeEl("summary");
const actionsItem = new FakeEl("button");
actions.append(actionsSummary, new FakeEl("div").append(actionsItem));
body.append(dialog, article, header, actions);

const fakeDocument = {
  addEventListener: register(documentListeners),
  querySelectorAll: (selector: string) => body.querySelectorAll(selector),
};
const fakeWindow = { addEventListener: register(windowListeners) };

const fire = (
  where: "document" | "window",
  type: string,
  event: FakeEvent = {}
): void => {
  const listeners = (
    where === "document" ? documentListeners : windowListeners
  ).get(type);
  if (!listeners?.length) {
    throw new Error(`no ${where} listener for ${type}`);
  }
  for (const listener of listeners) {
    listener(event);
  }
};

const saved = new Map(
  ["document", "window", "Node", "Element"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ])
);

let installDropdownDismiss: () => void;

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    Element: FakeEl,
    Node: FakeEl,
    document: fakeDocument,
    window: fakeWindow,
  })) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ installDropdownDismiss } =
    await import("../src/components/dropdown-dismiss.ts"));
  installDropdownDismiss();
});

afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
});

// Each case starts with the page-actions dropdown open and the header one
// closed; the "several open" cases open the header one themselves.
beforeEach(() => {
  actions.open = true;
  header.open = false;
  actionsSummary.focused = false;
  headerSummary.focused = false;
});

describe("installDropdownDismiss", () => {
  it("registers each listener once, even when several components install", () => {
    installDropdownDismiss();
    installDropdownDismiss();
    expect(
      [...documentListeners].map(([type, list]) => [type, list.length])
    ).toEqual([
      ["pointerdown", 1],
      ["keydown", 1],
      ["focusout", 1],
    ]);
    expect(
      [...windowListeners].map(([type, list]) => [type, list.length])
    ).toEqual([["blur", 1]]);
  });
});

describe("pointerdown", () => {
  it("closes the open dropdown on a press outside it", () => {
    fire("document", "pointerdown", { target: link });
    expect(actions.open).toBe(false);
    expect(actionsSummary.focused).toBe(false);
  });

  it("leaves the dropdown open on a press inside it", () => {
    fire("document", "pointerdown", { target: actionsItem });
    expect(actions.open).toBe(true);
    fire("document", "pointerdown", { target: actionsSummary });
    expect(actions.open).toBe(true);
  });

  it("closes on a press whose target is not a node", () => {
    fire("document", "pointerdown", { target: null });
    expect(actions.open).toBe(false);
  });

  it("never touches a plain <details> collapsible", () => {
    actions.open = false;
    fire("document", "pointerdown", { target: link });
    expect(collapsible.open).toBe(true);
  });

  it("closes every open dropdown except the one pressed", () => {
    header.open = true;
    fire("document", "pointerdown", { target: headerItem });
    expect(header.open).toBe(true);
    expect(actions.open).toBe(false);
  });
});

describe("keydown", () => {
  it("ignores keys other than Escape", () => {
    fire("document", "keydown", { key: "Enter", target: actionsItem });
    expect(actions.open).toBe(true);
  });

  it("ignores an IME composition cancel", () => {
    fire("document", "keydown", {
      isComposing: true,
      key: "Escape",
      target: actionsItem,
    });
    expect(actions.open).toBe(true);
  });

  it("leaves a dropdown under a modal dialog alone", () => {
    fire("document", "keydown", { key: "Escape", target: searchInput });
    expect(actions.open).toBe(true);
    expect(actionsSummary.focused).toBe(false);
  });

  it("closes and returns focus to the trigger when Escape came from inside", () => {
    fire("document", "keydown", { key: "Escape", target: actionsItem });
    expect(actions.open).toBe(false);
    expect(actionsSummary.focused).toBe(true);
  });

  it("closes without moving focus when Escape came from elsewhere", () => {
    fire("document", "keydown", { key: "Escape", target: link });
    expect(actions.open).toBe(false);
    expect(actionsSummary.focused).toBe(false);
  });

  it("closes every open dropdown, restoring focus only to the one Escape came from", () => {
    header.open = true;
    fire("document", "keydown", { key: "Escape", target: headerItem });
    expect(header.open).toBe(false);
    expect(actions.open).toBe(false);
    expect(headerSummary.focused).toBe(true);
    expect(actionsSummary.focused).toBe(false);
  });
});

describe("focusout", () => {
  it("closes when focus leaves the dropdown for an element outside it", () => {
    fire("document", "focusout", { relatedTarget: link, target: actionsItem });
    expect(actions.open).toBe(false);
    expect(actionsSummary.focused).toBe(false);
  });

  it("stays open while focus moves within the dropdown", () => {
    fire("document", "focusout", {
      relatedTarget: actionsItem,
      target: actionsSummary,
    });
    expect(actions.open).toBe(true);
  });

  it("stays open when focus goes nowhere focusable", () => {
    fire("document", "focusout", { relatedTarget: null, target: actionsItem });
    expect(actions.open).toBe(true);
  });

  it("stays open when focus moves between elements outside it", () => {
    fire("document", "focusout", { relatedTarget: link, target: searchInput });
    expect(actions.open).toBe(true);
  });

  it("closes only the dropdown focus left", () => {
    header.open = true;
    fire("document", "focusout", { relatedTarget: link, target: headerItem });
    expect(header.open).toBe(false);
    expect(actions.open).toBe(true);
  });
});

describe("window blur", () => {
  it("closes every open dropdown", () => {
    header.open = true;
    fire("window", "blur");
    expect(header.open).toBe(false);
    expect(actions.open).toBe(false);
    expect(actionsSummary.focused).toBe(false);
  });

  it("never touches a plain <details> collapsible", () => {
    actions.open = false;
    fire("window", "blur");
    expect(collapsible.open).toBe(true);
  });
});
