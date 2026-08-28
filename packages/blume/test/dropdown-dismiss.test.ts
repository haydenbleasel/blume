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

/** A minimal element: tag, tree, `<details>` open state, focus tracking. */
class FakeEl {
  children: FakeEl[] = [];
  focused = false;
  open = false;
  parent: FakeEl | null = null;
  tag: string;
  dropdown: boolean;

  constructor(tag: string, dropdown = false) {
    this.tag = tag;
    this.dropdown = dropdown;
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

  /** Only the two selectors the module issues. */
  querySelector(selector: string): FakeEl | null {
    if (selector === "summary") {
      return this.descendants().find((node) => node.tag === "summary") ?? null;
    }
    return (
      this.descendants().find(
        (node) => node.tag === "details" && node.dropdown && node.open
      ) ?? null
    );
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

const documentListeners = new Map<string, Listener>();
const windowListeners = new Map<string, Listener>();

// The tree: body > [dialog > input, article > link, dropdown(details > summary, div > button)]
const body = new FakeEl("body");
const dialog = new FakeEl("dialog");
const searchInput = new FakeEl("input");
dialog.append(searchInput);
const article = new FakeEl("article");
const link = new FakeEl("a");
article.append(link);
const dropdown = new FakeEl("details", true);
const summary = new FakeEl("summary");
const panel = new FakeEl("div");
const item = new FakeEl("button");
panel.append(item);
dropdown.append(summary, panel);
// A second, non-dropdown <details> (a collapsible in the article) must never
// be treated as the open menu.
const collapsible = new FakeEl("details");
collapsible.open = true;
body.append(dialog, article, dropdown, collapsible);

const fakeDocument = {
  addEventListener: (type: string, listener: Listener) => {
    documentListeners.set(type, listener);
  },
  querySelector: (selector: string) => body.querySelector(selector),
};
const fakeWindow = {
  addEventListener: (type: string, listener: Listener) => {
    windowListeners.set(type, listener);
  },
};

const fire = (
  where: "document" | "window",
  type: string,
  event: FakeEvent = {}
): void => {
  const listener = (
    where === "document" ? documentListeners : windowListeners
  ).get(type);
  if (!listener) {
    throw new Error(`no ${where} listener for ${type}`);
  }
  listener(event);
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

beforeEach(() => {
  dropdown.open = true;
  summary.focused = false;
});

describe("installDropdownDismiss", () => {
  it("registers each listener once, even when several components install", () => {
    installDropdownDismiss();
    installDropdownDismiss();
    expect([...documentListeners.keys()].toSorted()).toEqual([
      "focusout",
      "keydown",
      "pointerdown",
    ]);
    expect([...windowListeners.keys()]).toEqual(["blur"]);
  });
});

describe("pointerdown", () => {
  it("closes the open dropdown on a press outside it", () => {
    fire("document", "pointerdown", { target: link });
    expect(dropdown.open).toBe(false);
    expect(summary.focused).toBe(false);
  });

  it("leaves the dropdown open on a press inside it", () => {
    fire("document", "pointerdown", { target: item });
    expect(dropdown.open).toBe(true);
    fire("document", "pointerdown", { target: summary });
    expect(dropdown.open).toBe(true);
  });

  it("closes on a press whose target is not a node", () => {
    fire("document", "pointerdown", { target: null });
    expect(dropdown.open).toBe(false);
  });

  it("does nothing when no dropdown is open", () => {
    dropdown.open = false;
    fire("document", "pointerdown", { target: link });
    expect(dropdown.open).toBe(false);
    expect(collapsible.open).toBe(true);
  });
});

describe("keydown", () => {
  it("ignores keys other than Escape", () => {
    fire("document", "keydown", { key: "Enter", target: item });
    expect(dropdown.open).toBe(true);
  });

  it("ignores an IME composition cancel", () => {
    fire("document", "keydown", {
      isComposing: true,
      key: "Escape",
      target: item,
    });
    expect(dropdown.open).toBe(true);
  });

  it("leaves a dropdown under a modal dialog alone", () => {
    fire("document", "keydown", { key: "Escape", target: searchInput });
    expect(dropdown.open).toBe(true);
    expect(summary.focused).toBe(false);
  });

  it("closes and returns focus to the trigger when Escape came from inside", () => {
    fire("document", "keydown", { key: "Escape", target: item });
    expect(dropdown.open).toBe(false);
    expect(summary.focused).toBe(true);
  });

  it("closes without moving focus when Escape came from elsewhere", () => {
    fire("document", "keydown", { key: "Escape", target: link });
    expect(dropdown.open).toBe(false);
    expect(summary.focused).toBe(false);
  });

  it("does nothing when no dropdown is open", () => {
    dropdown.open = false;
    fire("document", "keydown", { key: "Escape", target: link });
    expect(summary.focused).toBe(false);
  });
});

describe("focusout", () => {
  it("closes when focus moves to an element outside the dropdown", () => {
    fire("document", "focusout", { relatedTarget: link, target: item });
    expect(dropdown.open).toBe(false);
    expect(summary.focused).toBe(false);
  });

  it("stays open while focus moves within the dropdown", () => {
    fire("document", "focusout", { relatedTarget: item, target: summary });
    expect(dropdown.open).toBe(true);
  });

  it("stays open when focus goes nowhere focusable", () => {
    fire("document", "focusout", { relatedTarget: null, target: item });
    expect(dropdown.open).toBe(true);
  });

  it("does nothing when no dropdown is open", () => {
    dropdown.open = false;
    fire("document", "focusout", { relatedTarget: link, target: item });
    expect(dropdown.open).toBe(false);
  });
});

describe("window blur", () => {
  it("closes the open dropdown", () => {
    fire("window", "blur");
    expect(dropdown.open).toBe(false);
    expect(summary.focused).toBe(false);
  });

  it("does nothing when no dropdown is open", () => {
    dropdown.open = false;
    fire("window", "blur");
    expect(collapsible.open).toBe(true);
  });
});
