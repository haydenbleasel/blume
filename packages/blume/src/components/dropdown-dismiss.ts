/**
 * Light-dismiss for the site's `<details>`-based dropdowns: the page actions
 * (Export / Open in chat / Connect to MCP), the header language switcher and
 * the nav selectors all render the same floating `<details>` + absolute panel,
 * and a native `<details>` only closes when its own `<summary>` is clicked
 * again, leaving the panel hanging over the page. Any dropdown that opts in
 * with `data-blume-dropdown` gets the four legs of a real menu:
 *
 * - a pointer press outside the open panel closes it;
 * - Escape closes it, restoring focus to the trigger when the keypress
 *   originated inside the panel;
 * - keyboard focus leaving the panel closes it;
 * - the window losing focus closes it — the only signal the parent document
 *   gets when a press lands inside an `<iframe>` embed, since pointer events
 *   in a child browsing context never propagate up.
 *
 * Every listener sits on `document`/`window` once per real page load and
 * queries the DOM live, so client-router swaps (which rebuild the dropdown
 * markup) need no re-init and never stack duplicate listeners. Per-component
 * behavior — one-open-at-a-time within a group, viewport flipping — stays in
 * the component that owns it.
 */

const OPEN_DROPDOWN = "details[data-blume-dropdown][open]";

/**
 * Every dropdown currently open. Each component group keeps itself to one
 * open panel, but a page holds several groups (the header selectors and the
 * page actions), and a browser that doesn't focus a `<summary>` on click lets
 * a keyboard-opened panel join a pointer-opened one — so the dismissal rules
 * apply to all of them, never just the first in DOM order.
 */
const openDropdowns = (): HTMLDetailsElement[] => [
  ...document.querySelectorAll<HTMLDetailsElement>(OPEN_DROPDOWN),
];

/**
 * Close `open`. `restoreFocus` moves focus back to its trigger, which a
 * keyboard dismissal wants and a pointer or focus-driven one does not.
 */
const dismiss = (open: HTMLDetailsElement, restoreFocus: boolean): void => {
  open.open = false;
  if (restoreFocus) {
    open.querySelector<HTMLElement>("summary")?.focus();
  }
};

const isInside = (
  dropdown: HTMLDetailsElement,
  target: EventTarget | null
): boolean => target instanceof Node && dropdown.contains(target);

const onPointerDown = (event: PointerEvent): void => {
  for (const open of openDropdowns()) {
    if (!isInside(open, event.target)) {
      dismiss(open, false);
    }
  }
};

const onKeyDown = (event: KeyboardEvent): void => {
  // `isComposing`: an IME cancel arrives as Escape and isn't a dismissal.
  if (event.key !== "Escape" || event.isComposing) {
    return;
  }
  // An Escape aimed at a modal surface stacked on top (the search dialog
  // traps focus inside itself) dismisses that surface only — the same guard
  // the Ask panel applies. Everything outside the modal is inert, so a focus
  // restore here could not land anyway.
  if (event.target instanceof Element && event.target.closest("dialog")) {
    return;
  }
  // Only a keypress that originated inside a panel gets its focus returned
  // to that trigger; yanking focus from an unrelated control the user had
  // moved on to would be a surprise.
  for (const open of openDropdowns()) {
    dismiss(open, isInside(open, event.target));
  }
};

const onFocusOut = (event: FocusEvent): void => {
  // Only focus *leaving a panel* counts: a move between two unrelated controls
  // (a dialog handing focus back to its trigger, say) must not close a panel
  // that never held focus. And a null `relatedTarget` means focus went
  // nowhere focusable (a click on plain content, the panel being hidden, the
  // window blurring) — the pointer and blur legs own those, and closing here
  // would hide a panel item before its own click lands in browsers that
  // don't focus buttons on press.
  const { relatedTarget } = event;
  if (!(relatedTarget instanceof Node)) {
    return;
  }
  for (const open of openDropdowns()) {
    if (isInside(open, event.target) && !open.contains(relatedTarget)) {
      dismiss(open, false);
    }
  }
};

const onWindowBlur = (): void => {
  for (const open of openDropdowns()) {
    dismiss(open, false);
  }
};

let installed = false;

/**
 * Register the document/window listeners. Idempotent: every component that
 * renders a dropdown calls this from its own script, and a page may render
 * several of them.
 */
export const installDropdownDismiss = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusout", onFocusOut);
  window.addEventListener("blur", onWindowBlur);
};
