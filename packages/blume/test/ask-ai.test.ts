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
let effects: (() => unknown)[] = [];
let cleanups: (() => void)[] = [];

mock.module("react", () => ({
  useEffect: (effect: () => unknown) => {
    effects.push(effect);
  },
  useRef: (initial: unknown) => {
    const index = cursor;
    cursor += 1;
    if (!(index in cells)) {
      cells[index] = { current: initial };
    }
    return cells[index];
  },
  useState: (initial: unknown) => {
    const index = cursor;
    cursor += 1;
    if (!(index in cells)) {
      cells[index] = initial;
    }
    const set = (next: unknown) => {
      cells[index] =
        typeof next === "function"
          ? (next as (current: unknown) => unknown)(cells[index])
          : next;
    };
    return [cells[index], set];
  },
}));

// --- stub renderer ----------------------------------------------------------

/** A rendered element; function components are already invoked inline. */
interface StubElement {
  // Test-only inspection bag: prop values are asserted with precise casts.
  // oxlint-disable-next-line no-explicit-any -- heterogeneous JSX props
  props: Record<string, any>;
  type: unknown;
}

const jsx = (type: unknown, props: StubElement["props"]): unknown =>
  typeof type === "function"
    ? (type as (p: StubElement["props"]) => unknown)(props)
    : { props, type };

const JSX_RUNTIME = {
  Fragment: Symbol.for("blume.test.fragment"),
  jsx,
  jsxDEV: jsx,
  jsxs: jsx,
};
mock.module("react/jsx-runtime", () => JSX_RUNTIME);
mock.module("react/jsx-dev-runtime", () => JSX_RUNTIME);

mock.module("react-dom", () => ({
  createPortal: (node: unknown) => node,
}));

// DOMPurify needs a browser DOM; pass-through here so assertions can target
// the markdown renderer's output directly.
mock.module("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

// --- fake browser globals ---------------------------------------------------

/** Stands in for `HTMLElement` in the focus-restore `instanceof` check. */
class FakeElement {
  focusCount = 0;
  isConnected = true;
  focus() {
    this.focusCount += 1;
  }
}
(globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;

type Listener = (event: unknown) => void;
const windowListeners = new Map<string, Listener[]>();
const fakeWindow = {
  addEventListener(type: string, listener: Listener) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
  },
  location: { pathname: "/guide" },
  removeEventListener(type: string, listener: Listener) {
    windowListeners.set(
      type,
      (windowListeners.get(type) ?? []).filter((l) => l !== listener)
    );
  },
};
(globalThis as { window?: unknown }).window = fakeWindow;

const fakeBody = { dataset: {} as Record<string, string> };
const fakeDocument = { activeElement: null as unknown, body: fakeBody };
(globalThis as { document?: unknown }).document = fakeDocument;

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

let props: AskProps = {};

/** One "render": reset the cursor, call the component, re-run all effects. */
const render = (): unknown => {
  cursor = 0;
  effects = [];
  const tree = AskAI(props);
  runCleanups();
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") {
      cleanups.push(cleanup as () => void);
    }
  }
  return tree;
};

/** Mount a fresh component instance (empty state cells, clean globals). */
const fresh = (nextProps: AskProps = {}): unknown => {
  runCleanups();
  windowListeners.clear();
  delete fakeBody.dataset.blumeAsk;
  fakeDocument.activeElement = null;
  cells = [];
  props = nextProps;
  // Two passes: the first flips the post-mount portal guard, the second
  // renders the portaled panel.
  render();
  return render();
};

/** Deliver a window event to the island's live listeners. */
const dispatch = (type: string, event: unknown) => {
  for (const listener of windowListeners.get(type) ?? []) {
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
const keyEvent = (overrides: Record<string, unknown> = {}) => ({
  key: "Enter",
  nativeEvent: { isComposing: false },
  preventDefault: () => {
    /* keyboard stub */
  },
  shiftKey: false,
  ...overrides,
});

// --- tree traversal ---------------------------------------------------------

const isElement = (node: unknown): node is StubElement =>
  typeof node === "object" && node !== null && "props" in node;

const findAll = (
  node: unknown,
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
  node: unknown,
  predicate: (el: StubElement) => boolean
): StubElement => {
  const [first] = findAll(node, predicate);
  if (!first) {
    throw new Error("expected element not found in rendered tree");
  }
  return first;
};

const byLabel = (tree: unknown, label: string): StubElement =>
  find(tree, (el) => el.props["aria-label"] === label);

const hasClass = (el: StubElement, name: string): boolean =>
  typeof el.props.className === "string" && el.props.className.includes(name);

const userBubbles = (tree: unknown): StubElement[] =>
  findAll(tree, (el) => hasClass(el, "self-end"));

const answers = (tree: unknown): StubElement[] =>
  findAll(tree, (el) => hasClass(el, "prose"));

const answerHtml = (el: StubElement): string => {
  const [inner] = findAll(el, (node) =>
    Boolean(node.props.dangerouslySetInnerHTML)
  );
  return String(inner?.props.dangerouslySetInnerHTML?.__html ?? "");
};

const aside = (tree: unknown): StubElement =>
  find(tree, (el) => el.type === "aside");

const setComposer = (tree: unknown, value: string): void => {
  byLabel(tree, "Ask a question").props.onChange({ target: { value } });
};

const submit = (tree: unknown): void => {
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
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
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
    expect(answerHtml(answer as StubElement)).toContain('href="/guide"');
    expect(answerHtml(answer as StubElement)).toContain("for more.");
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
    expect(answerHtml(nonOk as StubElement)).toContain(
      "Sorry, something went wrong."
    );

    setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    tree = fresh();
    setComposer(tree, "offline?");
    tree = render();
    submit(tree);
    await settle();
    tree = render();
    const [offline] = answers(tree);
    expect(answerHtml(offline as StubElement)).toContain(
      "Sorry, something went wrong."
    );
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
    expect(answerHtml(streaming as StubElement)).toContain("Hello");

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
    expect(answerHtml(followUp as StubElement)).toContain("Fresh answer");
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
