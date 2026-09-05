import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * Tests for the shared clipboard + "Copied" feedback helpers
 * (`src/components/copy-feedback.ts`). Browser globals are faked the same way
 * ask-ai.test.ts fakes them; the originals are restored so later test files
 * see the environment they expect.
 */

/** The element holding focus (`document.activeElement`). */
let activeElement: FakeEl | null = null;
const setActive = (el: FakeEl): void => {
  activeElement = el;
};

/**
 * A minimal element: attributes, text, children, connection state, plus the
 * textarea surface (`value`, `select`, `remove`, `style`) the legacy copy
 * fallback drives and the focus bookkeeping it restores.
 */
class FakeEl {
  attributes = new Map<string, string>();
  children: FakeEl[] = [];
  className = "";
  dataset: Record<string, string | undefined> = {};
  focusCount = 0;
  isConnected = false;
  parent: FakeEl | null = null;
  style: Record<string, string> = {};
  textContent = "";
  value = "";
  append(child: FakeEl): void {
    child.isConnected = true;
    child.parent = this;
    this.children.push(child);
  }
  focus(): void {
    this.focusCount += 1;
    setActive(this);
  }
  remove(): void {
    this.isConnected = false;
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  select(): void {
    setActive(this);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

const body = new FakeEl();
body.isConnected = true;
/** What `document.execCommand("copy")` does: return a result, or throw. */
let execCommand: "throws" | boolean = true;
/** The text selected when the copy command last ran. */
let execSelection: string | null = null;
const fakeDocument = {
  get activeElement(): FakeEl | null {
    return activeElement;
  },
  body,
  createElement: (_tag: string): FakeEl => new FakeEl(),
  execCommand: (_command: string): boolean => {
    if (execCommand === "throws") {
      throw new Error("copy is not supported");
    }
    execSelection = activeElement?.value ?? null;
    return execCommand;
  },
};

let clipboardText: string | null = null;
let clipboardFails = false;
const fakeNavigator = {
  clipboard: {
    writeText: (text: string): Promise<void> => {
      if (clipboardFails) {
        return Promise.reject(new Error("blocked"));
      }
      clipboardText = text;
      return Promise.resolve();
    },
  },
};

const documentDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "document"
);
const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);
const htmlElementDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "HTMLElement"
);

beforeAll(() => {
  // `writable` so later test files (hooks.test.ts) can install their own
  // fakes with a plain assignment.
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: fakeNavigator,
    writable: true,
  });
  // The fallback restores focus only to an `HTMLElement`; make the fake
  // element pass that check.
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeEl,
    writable: true,
  });
});

afterAll(() => {
  // SAFETY: views globalThis as carrying just the three globals faked above,
  // so `delete` can remove them where no original descriptor existed.
  const globals = globalThis as {
    document?: unknown;
    navigator?: unknown;
    HTMLElement?: unknown;
  };
  if (documentDescriptor) {
    Object.defineProperty(globalThis, "document", documentDescriptor);
  } else {
    delete globals.document;
  }
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  } else {
    delete globals.navigator;
  }
  if (htmlElementDescriptor) {
    Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
  } else {
    delete globals.HTMLElement;
  }
});

const { announceCopied, copyText, createCopyFlash, flashLabel } =
  await import("../src/components/copy-feedback.ts");

/** The current live region (always the newest appended body child). */
const liveRegion = (): FakeEl | undefined => body.children.at(-1);

/** Present a fake element to `flashLabel`, which expects a DOM element. */
// SAFETY: flashLabel touches only `textContent` and `dataset`, both of which
// FakeEl provides; bun's test runtime has no real DOM element to construct.
const asLabel = (el: FakeEl): HTMLElement => el as FakeEl & HTMLElement;

describe("copyText", () => {
  it("returns true and writes the clipboard on success", async () => {
    clipboardFails = false;
    expect(await copyText("payload")).toBe(true);
    expect(clipboardText).toBe("payload");
  });

  it("falls back to the copy command when the clipboard API rejects", async () => {
    clipboardFails = true;
    execCommand = true;
    const button = new FakeEl();
    activeElement = button;
    const before = body.children.length;
    expect(await copyText("fallback")).toBe(true);
    clipboardFails = false;
    // The command ran over the temporary textarea's text, the textarea is
    // gone again, and focus is back on the element that had it.
    expect(execSelection).toBe("fallback");
    expect(body.children.length).toBe(before);
    expect(activeElement).toBe(button);
    expect(button.focusCount).toBe(1);
  });

  it("falls back when navigator.clipboard is missing entirely", async () => {
    // In-app browsers and insecure contexts ship no `navigator.clipboard`.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
      writable: true,
    });
    execCommand = true;
    activeElement = null;
    expect(await copyText("webview")).toBe(true);
    expect(execSelection).toBe("webview");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: fakeNavigator,
      writable: true,
    });
  });

  it("returns false when the copy command fails too", async () => {
    clipboardFails = true;
    execCommand = false;
    expect(await copyText("nope")).toBe(false);
    clipboardFails = false;
  });

  it("returns false when the copy command throws", async () => {
    clipboardFails = true;
    execCommand = "throws";
    const before = body.children.length;
    expect(await copyText("nope")).toBe(false);
    // The textarea is cleaned up even when the command throws.
    expect(body.children.length).toBe(before);
    clipboardFails = false;
    execCommand = true;
  });
});

describe("announceCopied", () => {
  it("creates a polite status region once and reuses it", () => {
    announceCopied("Copied!");
    const region = liveRegion();
    expect(region?.attributes.get("role")).toBe("status");
    expect(region?.className).toBe("sr-only");
    expect(region?.textContent).toBe("Copied!");

    const count = body.children.length;
    announceCopied("Copied again");
    expect(body.children.length).toBe(count);
    expect(liveRegion()?.textContent).toBe("Copied again");
  });

  it("re-creates the region after a swap disconnects it", () => {
    const region = liveRegion();
    if (!region) {
      throw new Error("expected a live region");
    }
    region.isConnected = false;
    announceCopied("Fresh");
    expect(liveRegion()).not.toBe(region);
    expect(liveRegion()?.textContent).toBe("Fresh");
  });
});

describe("createCopyFlash", () => {
  it("paints, announces, and reverts after the hold", async () => {
    const states: boolean[] = [];
    const flash = createCopyFlash(
      (copied) => states.push(copied),
      "Kopiert",
      10
    );
    flash();
    expect(states).toStrictEqual([true]);
    expect(liveRegion()?.textContent).toBe("Kopiert");
    await Bun.sleep(30);
    expect(states).toStrictEqual([true, false]);
  });

  it("restarts the hold instead of stacking timers", async () => {
    const states: boolean[] = [];
    const flash = createCopyFlash(
      (copied) => states.push(copied),
      undefined,
      25
    );
    flash();
    await Bun.sleep(10);
    flash();
    await Bun.sleep(10);
    // The first timer was cleared; without clearing it would already have
    // reverted here (10 + 10 < 25 for the second, > 25 combined for the first).
    expect(states).toStrictEqual([true, true]);
    await Bun.sleep(30);
    expect(states).toStrictEqual([true, true, false]);
  });
});

describe("flashLabel", () => {
  it("captures the original label once and restores it", async () => {
    const label = new FakeEl();
    label.textContent = "Copy URL";
    flashLabel(asLabel(label), "Copied!", 10);
    expect(label.textContent).toBe("Copied!");
    expect(liveRegion()?.textContent).toBe("Copied!");
    await Bun.sleep(30);
    expect(label.textContent).toBe("Copy URL");
  });

  it("keeps the original label across a double flash and extends the hold", async () => {
    const label = new FakeEl();
    label.textContent = "Copy URL";
    flashLabel(asLabel(label), "Copied!", 25);
    await Bun.sleep(10);
    // A second flash while showing "Copied!" must not capture "Copied!" as
    // the label, and must restart the hold rather than reverting early.
    flashLabel(asLabel(label), "Copied!", 25);
    await Bun.sleep(10);
    expect(label.textContent).toBe("Copied!");
    await Bun.sleep(30);
    expect(label.textContent).toBe("Copy URL");
  });
});
