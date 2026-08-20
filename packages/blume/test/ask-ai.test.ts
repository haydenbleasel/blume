import { afterAll, describe, expect, it, mock } from "bun:test";

/**
 * Tests for the Ask AI island (`src/components/islands/ask-ai.tsx`).
 *
 * Like hooks.test.ts, `react` is module-mocked with a minimal hook runtime
 * (state cells persisting across renders, effects flushed after each render,
 * cleanups run before the next flush) so the component executes as a plain
 * function. The automatic JSX runtime is mocked to return plain
 * `{ type, props }` records — invoking function components inline — so the
 * rendered tree can be traversed and its handlers driven without a DOM.
 */

// ask-ai.tsx resolves the Ask endpoint from `import.meta.env.BASE_URL` at
// module scope (Bun aliases `import.meta.env` to `process.env`).
process.env.BASE_URL = "/";

// --- minimal hook runtime ---------------------------------------------------

let cells: unknown[] = [];
let cursor = 0;
/** What the mocked useEffect stores: an effect returning an optional cleanup. */
type Effect = () => (() => void) | undefined;
let effects: Effect[] = [];
let cleanups: (() => void)[] = [];

/** Distinguishes updater callbacks from direct next-state values. */
const isUpdater = <T>(
  next: T | ((current: T) => T)
): next is (current: T) => T => typeof next === "function";

mock.module("react", () => ({
  // Not used by ask-ai.tsx, but module mocks leak across test files and the
  // "react" namespace keeps the export names of whichever mock instantiates
  // it first. hooks.test.ts imports useCallback from the same mock, so this
  // mock must export it too or that import dies when this file runs first
  // (Linux CI orders files differently than macOS).
  useCallback: <T>(fn: T) => fn,
  useEffect: (effect: Effect) => {
    effects.push(effect);
  },
  useRef: <T>(initial: T) => {
    const index = cursor;
    cursor += 1;
    if (!(index in cells)) {
      cells[index] = { current: initial };
    }
    return cells[index];
  },
  useState: <T>(initial: T) => {
    const index = cursor;
    cursor += 1;
    if (!(index in cells)) {
      cells[index] = initial;
    }
    const set = (nextState: T | ((current: T) => T)) => {
      // SAFETY: this cell was seeded by this same useState slot, so it holds
      // whatever T that slot's caller stores.
      cells[index] = isUpdater(nextState)
        ? nextState(cells[index] as T)
        : nextState;
    };
    return [cells[index], set];
  },
}));

// --- stub renderer ----------------------------------------------------------

/** The composer keydown shape the island's onKeyDown handler reads. */
interface ComposerKeyEvent {
  key: string;
  nativeEvent: { isComposing: boolean };
  preventDefault: () => void;
  shiftKey: boolean;
}

/**
 * Test-only inspection bag for rendered props. Handlers and value fields are
 * declared required because tests drive them directly — every element a given
 * assertion touches carries the ones it reads.
 */
interface StubProps {
  "aria-expanded"?: boolean;
  "aria-label"?: string;
  children?: StubNode;
  className?: string;
  dangerouslySetInnerHTML?: { __html: string };
  disabled: boolean;
  inert: boolean;
  onChange: (event: { target: { value: string } }) => void;
  onClick: () => void;
  onKeyDown: (event: ComposerKeyEvent) => void;
  onSubmit: (event: { preventDefault: () => void }) => void;
  value: string;
}

/** A rendered element; function components are already invoked inline. */
interface StubElement {
  props: StubProps;
  type: unknown;
}

/** What the stub runtime yields: element records, arrays, and primitives. */
type StubNode =
  | StubElement
  | StubNode[]
  | boolean
  | number
  | string
  | null
  | undefined;

/** A function component, invoked inline by the stub runtime. */
type StubComponent = (props: StubProps) => StubNode;

const isComponent = (
  type: StubComponent | string | symbol
): type is StubComponent => typeof type === "function";

const jsx = (
  type: StubComponent | string | symbol,
  props: StubProps
): StubNode => (isComponent(type) ? type(props) : { props, type });

const JSX_RUNTIME = {
  Fragment: Symbol.for("blume.test.fragment"),
  jsx,
  jsxDEV: jsx,
  jsxs: jsx,
};
mock.module("react/jsx-runtime", () => JSX_RUNTIME);
mock.module("react/jsx-dev-runtime", () => JSX_RUNTIME);

mock.module("react-dom", () => ({
  createPortal: <T>(node: T) => node,
}));

// DOMPurify needs a browser DOM; pass-through here so assertions can target
// the markdown renderer's output directly.
mock.module("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

// --- fake browser globals ---------------------------------------------------

/**
 * Stands in for `HTMLElement` in the focus-restore `instanceof` check, and for
 * a <body> child the overlay inert sweep can mark.
 */
class FakeElement {
  attributes = new Map<string, string>();
  focusCount = 0;
  isConnected = true;
  focus() {
    this.focusCount += 1;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

// SAFETY: the island reads browser globals Bun's test environment does not
// declare; this widened view is the single install/uninstall point for fakes.
const browserGlobals = globalThis as {
  document?: unknown;
  HTMLElement?: unknown;
  MutationObserver?: unknown;
  window?: unknown;
};
browserGlobals.HTMLElement = FakeElement;

/** The window/media event shapes the island's listeners read. */
interface FakeEventInit {
  ctrlKey?: boolean;
  detail?: { query?: string };
  key?: string;
  metaKey?: boolean;
  preventDefault?: () => void;
  target?: { closest: (selector: string) => object | null };
}
type Listener = (event: FakeEventInit) => void;
const windowListeners = new Map<string, Listener[]>();

// The overlay-mode focus sweep asks matchMedia whether the desktop dock is
// active. Desktop by default so unrelated tests skip the sweep entirely.
let mediaMatches = true;
let mediaListeners: Listener[] = [];
const fakeWindow = {
  addEventListener(type: string, listener: Listener) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
  },
  location: { pathname: "/guide" },
  matchMedia: (_query: string) => ({
    addEventListener(_type: string, listener: Listener) {
      mediaListeners.push(listener);
    },
    get matches() {
      return mediaMatches;
    },
    removeEventListener(_type: string, listener: Listener) {
      mediaListeners = mediaListeners.filter((l) => l !== listener);
    },
  }),
  removeEventListener(type: string, listener: Listener) {
    windowListeners.set(
      type,
      (windowListeners.get(type) ?? []).filter((l) => l !== listener)
    );
  },
};
browserGlobals.window = fakeWindow;

/** The `document.body` fields the island's overlay sweep touches. */
interface FakeBody {
  children: FakeElement[];
  dataset: { blumeAsk?: string };
}
const fakeBody: FakeBody = { children: [], dataset: {} };

/**
 * The `document` fields the island reads: focus restore, the portal target,
 * and the `astro:after-swap` subscription that re-anchors the portal after a
 * client-router navigation replaces `<body>`.
 */
interface FakeDocument {
  activeElement: FakeElement | null;
  addEventListener: (type: string, listener: Listener) => void;
  body: FakeBody;
  removeEventListener: (type: string, listener: Listener) => void;
}
const documentListeners = new Map<string, Listener[]>();
const fakeDocument: FakeDocument = {
  activeElement: null,
  addEventListener(type: string, listener: Listener) {
    documentListeners.set(type, [
      ...(documentListeners.get(type) ?? []),
      listener,
    ]);
  },
  body: fakeBody,
  removeEventListener(type: string, listener: Listener) {
    documentListeners.set(
      type,
      (documentListeners.get(type) ?? []).filter((l) => l !== listener)
    );
  },
};
browserGlobals.document = fakeDocument;

type MutationBatch = { addedNodes: unknown[] }[];
interface RecordedObserver {
  disconnect: () => void;
  disconnected: boolean;
  notify: (records: MutationBatch) => void;
  observe: (target: FakeBody) => void;
  observed: FakeBody | null;
}
let mutationObservers: RecordedObserver[] = [];
/**
 * Stands in for MutationObserver: the island's sweep constructs one per open;
 * tests feed mutation batches through `notify` and assert `disconnected`.
 * Returning an object literal makes `new` hand it back as the instance.
 */
const fakeMutationObserver = function fakeMutationObserver(
  notify: (records: MutationBatch) => void
): RecordedObserver {
  const observer: RecordedObserver = {
    disconnect() {
      observer.disconnected = true;
    },
    disconnected: false,
    notify,
    observe(target) {
      observer.observed = target;
    },
    observed: null,
  };
  mutationObservers.push(observer);
  return observer;
};
browserGlobals.MutationObserver = fakeMutationObserver;

// An Apple platform (⌘ hint) with a recording clipboard. Defined before the
// island is imported, since `IS_APPLE` is computed at module scope.
const clipboardWrites: string[] = [];
const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
      },
    },
    platform: "MacIntel",
  },
});

const { default: AskAI } = await import("../src/components/islands/ask-ai.tsx");

type AskProps = Parameters<typeof AskAI>[0];

// --- render harness ---------------------------------------------------------

const runCleanups = () => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
};

/** Effects may return a cleanup; anything else is discarded. */
const isCleanup = (value: (() => void) | undefined): value is () => void =>
  typeof value === "function";

let props: AskProps = {};

/** One "render": reset the cursor, call the component, re-run all effects. */
const render = (): StubNode => {
  cursor = 0;
  effects = [];
  const tree = AskAI(props);
  runCleanups();
  for (const effect of effects) {
    const cleanup = effect();
    if (isCleanup(cleanup)) {
      cleanups.push(cleanup);
    }
  }
  return tree;
};

/** Mount a fresh component instance (empty state cells, clean globals). */
const fresh = (nextProps: AskProps = {}): StubNode => {
  runCleanups();
  windowListeners.clear();
  documentListeners.clear();
  mediaMatches = true;
  mediaListeners = [];
  mutationObservers = [];
  fakeBody.children = [];
  delete fakeBody.dataset.blumeAsk;
  fakeDocument.activeElement = null;
  fakeDocument.body = fakeBody;
  cells = [];
  props = nextProps;
  // Two passes: the first flips the post-mount portal guard, the second
  // renders the portaled panel.
  render();
  return render();
};

/** Deliver a window event to the island's live listeners. */
const dispatch = (type: string, event: FakeEventInit) => {
  for (const listener of windowListeners.get(type) ?? []) {
    listener(event);
  }
};

/** Deliver a document event (the client-router swap events live here). */
const dispatchDocument = (type: string, event: FakeEventInit) => {
  for (const listener of documentListeners.get(type) ?? []) {
    listener(event);
  }
};

/** Let the streaming loop's pending microtasks and reads settle. */
const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential macrotask drain
    await Bun.sleep(0);
  }
};

/** A composer keydown event; overrides adjust the Enter-to-send defaults. */
const keyEvent = (
  overrides: Partial<ComposerKeyEvent> = {}
): ComposerKeyEvent => ({
  key: "Enter",
  nativeEvent: { isComposing: false },
  preventDefault: () => {
    /* keyboard stub */
  },
  shiftKey: false,
  ...overrides,
});

// --- tree traversal ---------------------------------------------------------

const isElement = (node: StubNode): node is StubElement =>
  typeof node === "object" && node !== null && "props" in node;

const findAll = (
  node: StubNode,
  predicate: (el: StubElement) => boolean,
  out: StubElement[] = []
): StubElement[] => {
  if (Array.isArray(node)) {
    for (const child of node) {
      findAll(child, predicate, out);
    }
    return out;
  }
  if (!isElement(node)) {
    return out;
  }
  if (predicate(node)) {
    out.push(node);
  }
  findAll(node.props.children, predicate, out);
  return out;
};

const find = (
  node: StubNode,
  predicate: (el: StubElement) => boolean
): StubElement => {
  const [first] = findAll(node, predicate);
  if (!first) {
    throw new Error("expected element not found in rendered tree");
  }
  return first;
};

const byLabel = (tree: StubNode, label: string): StubElement =>
  find(tree, (el) => el.props["aria-label"] === label);

const hasClass = (el: StubElement, name: string): boolean =>
  el.props.className?.includes(name) ?? false;

const userBubbles = (tree: StubNode): StubElement[] =>
  findAll(tree, (el) => hasClass(el, "self-end"));

const answers = (tree: StubNode): StubElement[] =>
  findAll(tree, (el) => hasClass(el, "prose"));

const answerHtml = (el: StubNode): string => {
  const [inner] = findAll(el, (node) =>
    Boolean(node.props.dangerouslySetInnerHTML)
  );
  return String(inner?.props.dangerouslySetInnerHTML?.__html ?? "");
};

const aside = (tree: StubNode): StubElement =>
  find(tree, (el) => el.type === "aside");

const setComposer = (tree: StubNode, value: string): void => {
  byLabel(tree, "Ask a question").props.onChange({ target: { value } });
};

const submit = (tree: StubNode): void => {
  find(tree, (el) => el.type === "form").props.onSubmit({
    preventDefault: () => {
      /* form stub */
    },
  });
};

// --- fetch harness ----------------------------------------------------------

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (url: string, init?: RequestInit) => Promise<Response>
) => {
  // SAFETY: the island only ever calls fetch(url, init); none of the other
  // fetch overloads or statics are exercised in these tests.
  globalThis.fetch = handler as typeof fetch;
};

/** A streaming 200 response delivering `chunks` through a ReadableStream. */
const streamResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 }
  );
};

/** A streaming response whose chunks the test pushes by hand. */
const manualStream = () => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    { status: 200 }
  );
  return {
    abort: () =>
      controller.error(
        new DOMException("The operation was aborted.", "AbortError")
      ),
    close: () => controller.close(),
    push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    response,
  };
};

afterAll(() => {
  globalThis.fetch = originalFetch;
  runCleanups();
  delete browserGlobals.window;
  delete browserGlobals.document;
  delete browserGlobals.HTMLElement;
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  }
});

// --- tests ------------------------------------------------------------------

describe("AskAI empty state", () => {
  it("renders the prompt and the Apple shortcut hint without suggestions", () => {
    const tree = fresh();
    expect(
      findAll(
        tree,
        (el) => el.props.children === "Ask a question about the docs."
      )
    ).toHaveLength(1);
    expect(findAll(tree, (el) => el.props.children === "⌘")).toHaveLength(1);
    // No conversation yet: copy/clear are disabled.
    expect(byLabel(tree, "Copy conversation").props.disabled).toBe(true);
    expect(byLabel(tree, "Clear conversation").props.disabled).toBe(true);
  });

  it("honors custom strings and inlines the resolved icon glyphs", () => {
    const tree = fresh({
      icons: {
        arrowUp: "<a/>",
        chat: "<b/>",
        clear: "<c/>",
        close: "<d/>",
        copy: "<e/>",
      },
      strings: {
        ai: "Bot",
        clear: "Wipe",
        close: "Shut",
        copy: "Yank",
        empty: "Nothing yet.",
        error: "Broke.",
        label: "Type here",
        placeholder: "Go on…",
        send: "Fire",
        tip: "Toggle with",
        title: "Robot",
        you: "Me",
      },
    });
    for (const label of [
      "Robot",
      "Wipe",
      "Shut",
      "Yank",
      "Fire",
      "Type here",
    ]) {
      expect(byLabel(tree, label)).toBeDefined();
    }
    expect(
      findAll(tree, (el) => el.props.dangerouslySetInnerHTML?.__html === "<b/>")
    ).toHaveLength(1);
  });
});

describe("AskAI open/close", () => {
  it("toggles via the trigger, ⌘I / Ctrl+I, and Escape, driving the body attribute", () => {
    let tree = fresh();
    expect(byLabel(tree, "Ask AI").props["aria-expanded"]).toBe(false);
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    expect(byLabel(tree, "Ask AI").props["aria-expanded"]).toBe(true);
    expect(aside(tree).props.inert).toBe(false);
    expect(fakeBody.dataset.blumeAsk).toBe("open");

    dispatch("keydown", { ctrlKey: false, key: "Escape", metaKey: false });
    tree = render();
    expect(aside(tree).props.inert).toBe(true);
    expect(fakeBody.dataset.blumeAsk).toBeUndefined();

    let prevented = 0;
    const preventDefault = () => {
      prevented += 1;
    };
    dispatch("keydown", {
      ctrlKey: false,
      key: "I",
      metaKey: true,
      preventDefault,
    });
    tree = render();
    expect(prevented).toBe(1);
    expect(aside(tree).props.inert).toBe(false);
    dispatch("keydown", {
      ctrlKey: true,
      key: "i",
      metaKey: false,
      preventDefault,
    });
    tree = render();
    expect(aside(tree).props.inert).toBe(true);

    // Escape while closed and unrelated keys are no-ops.
    dispatch("keydown", { ctrlKey: false, key: "Escape", metaKey: false });
    dispatch("keydown", { ctrlKey: false, key: "x", metaKey: false });
    tree = render();
    expect(aside(tree).props.inert).toBe(true);
  });

  it("ignores an Escape aimed at a modal surface stacked on top", () => {
    let tree = fresh();
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    expect(aside(tree).props.inert).toBe(false);

    // The search dialog traps focus, so its Escape targets an element inside
    // a <dialog>; that dismissal must not also close the panel underneath.
    dispatch("keydown", {
      ctrlKey: false,
      key: "Escape",
      metaKey: false,
      target: {
        closest: (selector: string) => (selector === "dialog" ? {} : null),
      },
    });
    tree = render();
    expect(aside(tree).props.inert).toBe(false);

    // An Escape from outside any dialog still closes the panel.
    dispatch("keydown", {
      ctrlKey: false,
      key: "Escape",
      metaKey: false,
      target: { closest: () => null },
    });
    tree = render();
    expect(aside(tree).props.inert).toBe(true);
  });

  it("re-anchors onto the new body and re-stamps the push attribute after a client-router swap", () => {
    let tree = fresh();
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    expect(fakeBody.dataset.blumeAsk).toBe("open");

    // A swap installs a brand-new <body>: the push attribute arrives unset and
    // the previous portal container is a detached element. The island's
    // astro:after-swap subscription must adopt the new body and re-stamp it
    // while the panel is open.
    const swappedBody: FakeBody = { children: [], dataset: {} };
    fakeDocument.body = swappedBody;
    dispatchDocument("astro:after-swap", {});
    tree = render();
    expect(aside(tree).props.inert).toBe(false);
    expect(swappedBody.dataset.blumeAsk).toBe("open");

    // With the panel closed, a swap leaves the incoming body unstamped.
    dispatch("keydown", { ctrlKey: false, key: "Escape", metaKey: false });
    tree = render();
    const closedSwapBody: FakeBody = { children: [], dataset: {} };
    fakeDocument.body = closedSwapBody;
    dispatchDocument("astro:after-swap", {});
    tree = render();
    expect(aside(tree).props.inert).toBe(true);
    expect(closedSwapBody.dataset.blumeAsk).toBeUndefined();
  });

  it("accepts the search handoff event, with and without a forwarded query", () => {
    let tree = fresh();
    dispatch("blume:open-ask-ai", { detail: { query: "from search" } });
    tree = render();
    expect(aside(tree).props.inert).toBe(false);
    expect(byLabel(tree, "Ask a question").props.value).toBe("from search");

    byLabel(tree, "Close").props.onClick();
    tree = render();
    expect(aside(tree).props.inert).toBe(true);

    dispatch("blume:open-ask-ai", {});
    tree = render();
    expect(aside(tree).props.inert).toBe(false);
    expect(byLabel(tree, "Ask a question").props.value).toBe("from search");
  });

  it("inerts the rest of the page while the panel is a small-screen overlay", () => {
    // Below the desktop dock breakpoint, every other <body> child is swept
    // inert so Tab can't escape into the page the overlay covers. A sibling
    // that was already inert (another closed surface) must stay inert on close.
    const sibling = new FakeElement();
    const alreadyInert = new FakeElement();
    alreadyInert.setAttribute("inert", "");

    let tree = fresh();
    mediaMatches = false;
    fakeBody.children = [sibling, alreadyInert];
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    expect(sibling.hasAttribute("inert")).toBe(true);
    expect(alreadyInert.hasAttribute("inert")).toBe(true);

    byLabel(tree, "Close").props.onClick();
    tree = render();
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
  });

  it("re-evaluates the sweep when the viewport crosses the dock breakpoint", () => {
    const sibling = new FakeElement();
    let tree = fresh();
    mediaMatches = false;
    fakeBody.children = [sibling];
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    expect(sibling.hasAttribute("inert")).toBe(true);
    expect(mediaListeners).toHaveLength(1);

    // Growing into the desktop dock releases the sweep — the docked panel is
    // non-modal and the page stays interactive.
    mediaMatches = true;
    for (const listener of mediaListeners) {
      listener({});
    }
    expect(sibling.hasAttribute("inert")).toBe(false);

    // Shrinking back re-applies it.
    mediaMatches = false;
    for (const listener of mediaListeners) {
      listener({});
    }
    expect(sibling.hasAttribute("inert")).toBe(true);

    // Closing unsubscribes and releases.
    byLabel(tree, "Close").props.onClick();
    tree = render();
    expect(mediaListeners).toHaveLength(0);
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(aside(tree).props.inert).toBe(true);
  });

  it("sweeps nodes portaled into body while the overlay is open", () => {
    let tree = fresh();
    mediaMatches = false;
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    // SAFETY: opening the panel just constructed exactly one observer through
    // the mocked MutationObserver, so the list is non-empty.
    const observer = mutationObservers.at(-1) as RecordedObserver;
    expect(observer.observed).toBe(fakeBody);

    // A zoom overlay arrives after the open-time sweep; a text node and an
    // already-inert element ride the same mutation batch.
    const late = new FakeElement();
    const preInerted = new FakeElement();
    preInerted.setAttribute("inert", "");
    const textNode = { nodeType: 3 };
    observer.notify([{ addedNodes: [late, textNode, preInerted] }]);
    expect(late.hasAttribute("inert")).toBe(true);
    expect(preInerted.hasAttribute("inert")).toBe(true);

    // Close: the latecomer is released, the pre-inerted element is left
    // alone (it was not ours to re-enable), and the observer disconnects.
    byLabel(tree, "Close").props.onClick();
    tree = render();
    expect(late.hasAttribute("inert")).toBe(false);
    expect(preInerted.hasAttribute("inert")).toBe(true);
    expect(observer.disconnected).toBe(true);
  });

  it("leaves additions interactive while the desktop dock is active", () => {
    let tree = fresh();
    mediaMatches = false;
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    // SAFETY: opening the panel just constructed exactly one observer through
    // the mocked MutationObserver, so the list is non-empty.
    const observer = mutationObservers.at(-1) as RecordedObserver;

    // Growing into the dock releases the sweep; a node arriving then must
    // stay interactive — the docked panel is non-modal on purpose.
    mediaMatches = true;
    for (const listener of mediaListeners) {
      listener({});
    }
    const late = new FakeElement();
    observer.notify([{ addedNodes: [late] }]);
    expect(late.hasAttribute("inert")).toBe(false);
  });

  it("restores focus to the opener on close, skipping disconnected elements", () => {
    let tree = fresh();
    const opener = new FakeElement();
    fakeDocument.activeElement = opener;
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    byLabel(tree, "Close").props.onClick();
    tree = render();
    expect(opener.focusCount).toBe(1);

    const stale = new FakeElement();
    stale.isConnected = false;
    fakeDocument.activeElement = stale;
    byLabel(tree, "Ask AI").props.onClick();
    tree = render();
    byLabel(tree, "Close").props.onClick();
    tree = render();
    expect(stale.focusCount).toBe(0);
  });
});

describe("AskAI conversation", () => {
  it("streams a suggestion's answer, grounding the request and basing citations", async () => {
    const requests: { init?: RequestInit; url: string }[] = [];
    setFetch((url, init) => {
      requests.push({ init, url });
      return Promise.resolve(
        streamResponse(["See [Guide](/guide)", " for more."])
      );
    });
    let tree = fresh({
      suggestions: [
        { icon: "<svg>s</svg>", label: "How do I deploy?" },
        { icon: null, label: "What is Blume?" },
      ],
    });
    // One resolved suggestion icon; the null one renders label-only.
    expect(
      findAll(
        tree,
        (el) => el.props.dangerouslySetInnerHTML?.__html === "<svg>s</svg>"
      )
    ).toHaveLength(1);

    const [first] = findAll(
      tree,
      (el) => el.type === "button" && hasClass(el, "text-start")
    );
    first?.props.onClick();
    await settle();
    tree = render();

    expect(requests[0]?.url).toBe("/api/ask");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.page).toStrictEqual({ path: "/guide" });
    expect(body.messages).toStrictEqual([
      { content: "How do I deploy?", role: "user" },
    ]);
    expect(userBubbles(tree).map((b) => b.props.children)).toStrictEqual([
      "How do I deploy?",
    ]);
    const [answer] = answers(tree);
    expect(answer).toBeDefined();
    expect(answerHtml(answer)).toContain('href="/guide"');
    expect(answerHtml(answer)).toContain("for more.");
  });

  it("submits on Enter but not Shift+Enter, mid-composition, or when empty", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return Promise.resolve(streamResponse(["ok"]));
    });
    let tree = fresh();
    const composer = byLabel(tree, "Ask a question");
    composer.props.onKeyDown(keyEvent({ shiftKey: true }));
    composer.props.onKeyDown(keyEvent({ nativeEvent: { isComposing: true } }));
    composer.props.onKeyDown(keyEvent({ key: "a" }));
    // Empty input: runQuestion("") returns before fetching.
    composer.props.onKeyDown(keyEvent());
    await settle();
    expect(calls).toBe(0);

    setComposer(tree, "  hi  ");
    tree = render();
    byLabel(tree, "Ask a question").props.onKeyDown(keyEvent());
    await settle();
    expect(calls).toBe(1);
    tree = render();
    // The question is trimmed and the composer cleared.
    expect(userBubbles(tree).map((b) => b.props.children)).toStrictEqual([
      "hi",
    ]);
    expect(byLabel(tree, "Ask a question").props.value).toBe("");
  });

  it("replaces the placeholder with the error notice when the endpoint fails", async () => {
    setFetch(() => Promise.resolve(new Response("boom", { status: 500 })));
    let tree = fresh();
    setComposer(tree, "broken?");
    tree = render();
    submit(tree);
    await settle();
    tree = render();
    const [nonOk] = answers(tree);
    expect(answerHtml(nonOk)).toContain("Sorry, something went wrong.");

    setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    tree = fresh();
    setComposer(tree, "offline?");
    tree = render();
    submit(tree);
    await settle();
    tree = render();
    const [offline] = answers(tree);
    expect(answerHtml(offline)).toContain("Sorry, something went wrong.");
  });

  it("copies the conversation as You/AI lines", async () => {
    setFetch(() => Promise.resolve(streamResponse(["The answer."])));
    let tree = fresh();
    setComposer(tree, "The question?");
    tree = render();
    submit(tree);
    await settle();
    tree = render();
    expect(byLabel(tree, "Copy conversation").props.disabled).toBe(false);
    byLabel(tree, "Copy conversation").props.onClick();
    expect(clipboardWrites.at(-1)).toBe(
      "You: The question?\n\nAI: The answer."
    );
  });
});

describe("AskAI clear during a streaming answer", () => {
  it("aborts the request and keeps late chunks from resurrecting an orphaned bubble", async () => {
    // The signal is deliberately not wired to the stream: even if the abort
    // never reaches the network layer, the cleared generation must stop the
    // in-flight updater from writing into the emptied conversation.
    const stream = manualStream();
    let signal: AbortSignal | undefined;
    setFetch((_url, init) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(stream.response);
    });
    let tree = fresh();
    setComposer(tree, "Question one");
    tree = render();
    submit(tree);
    await settle();
    tree = render();
    // The question bubble and the pulsing placeholder are up.
    expect(userBubbles(tree)).toHaveLength(1);
    expect(findAll(tree, (el) => hasClass(el, "animate-pulse"))).toHaveLength(
      1
    );

    // A second question is ignored while the stream is busy.
    setComposer(tree, "impatient");
    tree = render();
    submit(tree);
    await settle();
    tree = render();
    expect(userBubbles(tree)).toHaveLength(1);

    stream.push("Hello");
    await settle();
    tree = render();
    const [streaming] = answers(tree);
    expect(answerHtml(streaming)).toContain("Hello");

    byLabel(tree, "Clear conversation").props.onClick();
    expect(signal?.aborted).toBe(true);
    stream.push(" world");
    await settle();
    stream.close();
    await settle();
    tree = render();
    expect(userBubbles(tree)).toHaveLength(0);
    expect(answers(tree)).toHaveLength(0);

    // The panel is immediately usable: a follow-up question streams normally.
    setFetch(() => Promise.resolve(streamResponse(["Fresh answer"])));
    setComposer(tree, "Question two");
    tree = render();
    submit(tree);
    await settle();
    tree = render();
    expect(userBubbles(tree).map((b) => b.props.children)).toStrictEqual([
      "Question two",
    ]);
    const [followUp] = answers(tree);
    expect(answerHtml(followUp)).toContain("Fresh answer");
  });

  it("does not paint the cleared stream's abort as an error notice", async () => {
    const stream = manualStream();
    setFetch((_url, init) => {
      // Mirror real fetch: aborting the signal rejects the pending read.
      init?.signal?.addEventListener("abort", stream.abort);
      return Promise.resolve(stream.response);
    });
    let tree = fresh();
    setComposer(tree, "Question");
    tree = render();
    submit(tree);
    await settle();
    stream.push("partial");
    await settle();
    tree = render();
    expect(answers(tree)).toHaveLength(1);

    byLabel(tree, "Clear conversation").props.onClick();
    await settle();
    tree = render();
    expect(userBubbles(tree)).toHaveLength(0);
    expect(answers(tree)).toHaveLength(0);
    expect(
      findAll(
        tree,
        (el) => el.props.children === "Ask a question about the docs."
      )
    ).toHaveLength(1);
  });
});
