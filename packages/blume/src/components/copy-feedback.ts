/**
 * Shared clipboard + "Copied" feedback used by every copy affordance (code
 * blocks, page actions, color swatches, prompts, API panels, Ask AI). One
 * implementation owns the invariants each site used to hand-roll:
 *
 * - the clipboard write is guarded and a confirmation must never lie: a
 *   site either shows nothing on failure or (the page actions) shows a
 *   failure label, but never a false "Copied";
 * - repeat copies restart the hold instead of stacking timers, so the copied
 *   state never reverts early after a double-click;
 * - every flash is announced to a shared polite live region, so the
 *   confirmation — or the failure — is audible, not just visual (previously
 *   only the code-block button announced).
 */

/** How long the copied confirmation holds before reverting. */
const HOLD_MS = 1500;

/** The shared visually-hidden live region, created on first announcement. */
let region: HTMLElement | null = null;

/**
 * Announce `message` to screen readers. The region is re-created if a swap
 * (view transition, client router) disconnected it.
 */
export const announceCopied = (message: string): void => {
  if (!region?.isConnected) {
    region = document.createElement("div");
    region.setAttribute("role", "status");
    region.className = "sr-only";
    document.body.append(region);
  }
  // Clear first so repeating the same message is re-announced.
  region.textContent = "";
  region.textContent = message;
};

/**
 * The legacy copy path: select `text` in an off-screen textarea and run the
 * `copy` editing command. It needs no clipboard permission, only the user
 * activation the click already provides, so it covers the places the async
 * Clipboard API doesn't reach — in-app browsers and WebViews that ship no
 * `navigator.clipboard`, insecure origins, and a denied permission prompt.
 */
const copyViaCommand = (text: string): boolean => {
  const previous = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  // Off-screen rather than `display: none`: hidden controls can't be selected.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  // Beside the focused control, not on `<body>`: `select()` moves focus to the
  // textarea, and a copy button inside a light-dismissed `<details>` menu (the
  // MCP actions) would otherwise see focus leave the panel — closing the menu
  // mid-click and hiding the label the outcome is about to flash on.
  const host =
    previous instanceof HTMLElement && previous.parentElement
      ? previous.parentElement
      : document.body;
  host.append(textarea);
  textarea.select();
  // iOS WebKit has been known to ignore `select()` on a readonly textarea;
  // an explicit range covers it (the same belt-and-braces clipboard.js uses).
  textarea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // Some engines throw instead of returning false; either way it failed.
  }
  textarea.remove();
  // `select()` moved focus to the textarea; put it back on the button so a
  // keyboard user isn't dropped at the top of the document.
  if (previous instanceof HTMLElement) {
    previous.focus();
  }
  return copied;
};

/**
 * Copy `text` to the clipboard. Returns whether the write succeeded. The async
 * Clipboard API is tried first; when it is missing (in-app browsers, insecure
 * contexts) or rejects (a denied permission), the legacy `copy` command is
 * tried before giving up, so callers only see `false` when nothing worked and
 * can show a failure instead of silently doing nothing.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaCommand(text);
  }
};

/**
 * Copy text that still has to be loaded — the page's Markdown mirror, fetched
 * on click. Safari and Firefox only honor a clipboard write issued inside the
 * click's own task: awaiting the load first lands the write outside the user
 * activation, so `writeText` rejects and the legacy command returns `false`
 * even though the clipboard is perfectly available. `ClipboardItem` accepts a
 * promise for its payload, so the write is issued synchronously with the
 * load still in flight and the activation intact. Engines without it (or a
 * write that rejects for any reason, a failed load included) fall back to the
 * awaited {@link copyText}, which is what Chrome's longer activation window
 * already tolerated. A load failure still throws, so the caller can report
 * it rather than a clipboard problem.
 */
export const copyDeferredText = async (
  load: () => Promise<string>
): Promise<boolean> => {
  const text = load();
  if ("ClipboardItem" in globalThis) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": text.then(
            (value) => new Blob([value], { type: "text/plain" })
          ),
        }),
      ]);
      return true;
    } catch {
      // Fall through to the awaited write; if the load itself failed, the
      // `await` below rethrows that error for the caller.
    }
  }
  return copyText(await text);
};

/**
 * A per-affordance flash: `apply(true)` paints the copied state, `apply(false)`
 * reverts it after the hold. Calling the returned function again restarts the
 * hold. `announce` (the localized "Copied" label) is spoken on each flash.
 */
export const createCopyFlash = (
  apply: (copied: boolean) => void,
  announce?: string,
  holdMs: number = HOLD_MS
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    apply(true);
    if (announce) {
      announceCopied(announce);
    }
    timer = setTimeout(() => apply(false), holdMs);
  };
};

/** Flash timers for {@link flashLabel}, keyed per element. */
const labelTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * The text-swap flash: show `message` in `el`, then restore its own (possibly
 * localized) label after the hold. The original label is captured once, on the
 * first flash — capturing at click time would capture the flash message itself
 * on a double-click and stick until reload.
 */
export const flashLabel = (
  el: HTMLElement,
  message: string,
  holdMs: number = HOLD_MS
): void => {
  el.dataset.blumeLabel ??= el.textContent ?? "";
  el.textContent = message;
  announceCopied(message);
  clearTimeout(labelTimers.get(el));
  labelTimers.set(
    el,
    setTimeout(() => {
      el.textContent = el.dataset.blumeLabel ?? "";
    }, holdMs)
  );
};
