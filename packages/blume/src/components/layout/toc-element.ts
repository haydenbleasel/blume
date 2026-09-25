/**
 * Client behavior for the `<blume-toc>` custom element wrapping each "On this
 * page" list. As the reader scrolls, it marks the link for the section currently
 * in view with `aria-current="location"` — styled via Tailwind `aria-[current]`
 * variants in RootLayout — giving the table of contents a live scrollspy.
 *
 * The active heading is chosen by rect (the last heading at or above a trigger
 * line just below the sticky header), so it stays correct for sections taller
 * than the viewport and at the bottom of the page; headings that aren't rendered
 * (inside a hidden tab panel) are skipped (see toc-active.ts). An IntersectionObserver is the
 * cheap primary trigger — it only fires as headings cross the band near the top —
 * and a passive, rAF-throttled scroll listener covers the one case it can't: a
 * final section too short to push its heading past the trigger line.
 *
 * Imported for its side effect (registers the element) from RootLayout's script.
 */

import { activeTocEntry } from "./toc-active.ts";

interface TocEntry {
  heading: HTMLElement;
  link: HTMLAnchorElement;
}

// Matches the theme's `scroll-padding-top: 4.5rem`, so the highlighted heading
// agrees with where a clicked anchor lands beneath the sticky header.
const TRIGGER_OFFSET = 72;

class BlumeToc extends HTMLElement {
  #entries: TocEntry[] = [];
  #observer: IntersectionObserver | null = null;
  #current: HTMLAnchorElement | null = null;
  #ticking = false;

  connectedCallback() {
    for (const link of this.querySelectorAll<HTMLAnchorElement>(
      'a[href^="#"]'
    )) {
      const id = decodeURIComponent(link.hash.slice(1));
      const heading = id
        ? document.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        : null;
      if (heading) {
        this.#entries.push({ heading, link });
      }
    }
    if (this.#entries.length === 0) {
      return;
    }

    this.#observer = new IntersectionObserver(() => this.#update(), {
      rootMargin: `-${TRIGGER_OFFSET}px 0px -70% 0px`,
      threshold: 0,
    });
    for (const { heading } of this.#entries) {
      this.#observer.observe(heading);
    }
    // The scroll listener is the intentional fallback for the one case the
    // IntersectionObserver can't cover (a final section too short to push its
    // heading past the trigger line), so replacing it with an observer would
    // change behavior. `scroll` isn't cancelable, so it never preventDefaults
    // and `{ passive: true }` would be a no-op here.
    // oxlint-disable-next-line github/prefer-observers, react-doctor/client-passive-event-listeners
    window.addEventListener("scroll", this.#onScroll);
    this.#update();
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
    this.#observer = null;
    window.removeEventListener("scroll", this.#onScroll);
  }

  #onScroll = () => {
    if (this.#ticking) {
      return;
    }
    this.#ticking = true;
    requestAnimationFrame(() => {
      this.#ticking = false;
      this.#update();
    });
  };

  #update() {
    const active = this.#activeLink();
    if (active === this.#current) {
      return;
    }
    this.#current?.removeAttribute("aria-current");
    active?.setAttribute("aria-current", "location");
    this.#current = active;
  }

  #activeLink(): HTMLAnchorElement | null {
    const scrolledToBottom =
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 2;
    return (
      activeTocEntry(this.#entries, TRIGGER_OFFSET, scrolledToBottom)?.link ??
      null
    );
  }
}

if (!customElements.get("blume-toc")) {
  customElements.define("blume-toc", BlumeToc);
}
