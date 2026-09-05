import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * Tests for `copyDeferredText` (`src/components/copy-feedback.ts`): the
 * clipboard write that must be issued before its text has loaded, so it
 * stays inside the click's user activation on Safari and Firefox. The
 * `ClipboardItem` global and `navigator.clipboard.write` are faked here;
 * the legacy fallback path is covered by copy-feedback.test.ts.
 */

/** A `ClipboardItem` stand-in that just records its payload map. */
class FakeClipboardItem {
  readonly items: Record<string, Promise<Blob>>;
  constructor(items: Record<string, Promise<Blob>>) {
    this.items = items;
  }
}

let clipboardText: string | null = null;
/** What `navigator.clipboard.write` does: resolve, or reject. */
let clipboardWriteFails = false;
/** The `ClipboardItem` payloads handed to `navigator.clipboard.write`. */
const clipboardWrites: FakeClipboardItem[] = [];

/** A real engine commits the write only once every payload has resolved. */
const commit = async (item: FakeClipboardItem): Promise<void> => {
  const blobs = await Promise.all(Object.values(item.items));
  const texts = await Promise.all(blobs.map((blob) => blob.text()));
  clipboardText = texts.at(-1) ?? clipboardText;
};

const fakeNavigator = {
  clipboard: {
    write: async (items: FakeClipboardItem[]): Promise<void> => {
      clipboardWrites.push(...items);
      if (clipboardWriteFails) {
        throw new Error("blocked");
      }
      await Promise.all(items.map(commit));
    },
    writeText: (text: string): Promise<void> => {
      clipboardText = text;
      return Promise.resolve();
    },
  },
};

const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);
const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "ClipboardItem"
);

/** Install a `ClipboardItem` global, or remove it (`null`). */
const installClipboardItem = (value: typeof FakeClipboardItem | null): void => {
  if (value === null) {
    // SAFETY: views globalThis as carrying just the faked constructor.
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    return;
  }
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value,
    writable: true,
  });
};

beforeAll(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: fakeNavigator,
    writable: true,
  });
});

afterAll(() => {
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  } else {
    // SAFETY: views globalThis as carrying just the faked navigator.
    delete (globalThis as { navigator?: unknown }).navigator;
  }
  if (clipboardItemDescriptor) {
    Object.defineProperty(globalThis, "ClipboardItem", clipboardItemDescriptor);
  } else {
    installClipboardItem(null);
  }
});

const { copyDeferredText } = await import("../src/components/copy-feedback.ts");

describe("copyDeferredText", () => {
  it("writes a promised ClipboardItem without awaiting the load first", async () => {
    installClipboardItem(FakeClipboardItem);
    clipboardWriteFails = false;
    clipboardWrites.length = 0;
    let loaded = false;
    const load = () =>
      Bun.sleep(5).then(() => {
        loaded = true;
        return "deferred";
      });
    const result = copyDeferredText(load);
    // The write was issued synchronously — before the load settled — so it
    // still sits inside the click's user activation.
    expect(clipboardWrites.length).toBe(1);
    expect(loaded).toBe(false);
    expect(await result).toBe(true);
    expect(clipboardText).toBe("deferred");
  });

  it("falls back to the awaited write when the promised write rejects", async () => {
    installClipboardItem(FakeClipboardItem);
    clipboardWriteFails = true;
    expect(await copyDeferredText(() => Promise.resolve("retry"))).toBe(true);
    expect(clipboardText).toBe("retry");
    clipboardWriteFails = false;
  });

  it("falls back to the awaited write when ClipboardItem is unsupported", async () => {
    installClipboardItem(null);
    clipboardWrites.length = 0;
    expect(await copyDeferredText(() => Promise.resolve("legacy"))).toBe(true);
    expect(clipboardWrites.length).toBe(0);
    expect(clipboardText).toBe("legacy");
  });

  it("rethrows a load failure instead of reporting a clipboard failure", async () => {
    installClipboardItem(FakeClipboardItem);
    clipboardWriteFails = false;
    const failure = new Error("Fetching /x.md failed (404)");
    await expect(copyDeferredText(() => Promise.reject(failure))).rejects.toBe(
      failure
    );
  });
});
