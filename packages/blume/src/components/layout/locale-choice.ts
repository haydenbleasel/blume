/**
 * The switcher's half of routing by browser language: the pick it remembers.
 * The language switcher bundles this module for the browser, so it imports
 * nothing. `core/i18n.ts` in particular carries every translation pack, and
 * anything that reaches it puts them all in the switcher's script. The half
 * that renders with the page is in locale-redirect.ts.
 */

/** The key for the language a visitor picks with the switcher. */
export const LOCALE_STORAGE_KEY = "blume-locale";

/** A click target that can look up its ancestors: an element. */
interface ClosestTarget {
  closest: (selector: string) => {
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, value: string) => void;
  } | null;
}

/** A click, as the listener reads it. */
interface Click {
  /** The mouse button: 0 for the main one, 1 for the middle one. */
  button: number;
  target: EventTarget | ClosestTarget | null;
}

/** What {@link rememberLocaleChoice} listens on: the document. */
export interface ChoiceTarget {
  addEventListener: (
    type: "auxclick" | "click",
    listener: (event: Click) => void,
    options: { capture: true }
  ) => void;
  location: { readonly hash: string };
}

const hasClosest = (target: Click["target"]): target is ClosestTarget =>
  target !== null && "closest" in target;

/** The switcher link a click landed on, if any. */
const chosenLink = (target: Click["target"]) =>
  hasClosest(target) ? target.closest("a[data-blume-locale-choice]") : null;

/**
 * Remember a language picked with the switcher, so routing by browser
 * language stops sending the reader elsewhere, and keep the reader's place:
 * the chosen link carries the current fragment (a heading the translation
 * lacks leaves the reader at the top). One listener on the document covers
 * every switcher, on every page the client router swaps in. It listens in
 * the capture phase: the client router's own listener on the document reads
 * the link's href and navigates, and it's registered first. A middle click,
 * which opens the language in a new tab, fires `auxclick` instead of `click`,
 * so the listener takes both.
 */
export const rememberLocaleChoice = (target: ChoiceTarget): void => {
  const remember = (event: Click): void => {
    // Only the main and middle buttons follow a link: `auxclick` fires for
    // the others too, and a right click isn't a pick.
    if (event.button > 1) {
      return;
    }
    const link = chosenLink(event.target);
    const code = link?.getAttribute("hreflang");
    if (!(link && code)) {
      return;
    }
    // Rewritten even without a fragment, so one left by an earlier click
    // (one that opened a new tab) doesn't stick.
    const href = link.getAttribute("href");
    if (href !== null) {
      link.setAttribute("href", href.split("#")[0] + target.location.hash);
    }
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, code);
    } catch {
      // Storage can be off; routing then stays off too (see
      // LOCALE_REDIRECT_SCRIPT in locale-redirect.ts).
    }
  };
  target.addEventListener("click", remember, { capture: true });
  target.addEventListener("auxclick", remember, { capture: true });
};
