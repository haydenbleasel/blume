/**
 * Client behaviour for the `<blume-toc>` custom element wrapping each "On this
 * page" list. As the reader scrolls, it marks the link for the section currently
 * in view with `aria-current="location"` — styled via Tailwind `aria-[current]`
 * variants in RootLayout — giving the table of contents a live scrollspy.
 *
 * The active heading is chosen by rect (the last heading at or above a trigger
 * line just below the sticky header), so it stays correct for sections taller
 * than the viewport and at the bottom of the page. An IntersectionObserver is the
 * cheap primary trigger — it only fires as headings cross the band near the top —
 * and a passive, rAF-throttled scroll listener covers the one case it can't: a
 * final section too short to push its heading past the trigger line.
 *
 * Imported for its side effect (registers the element) from RootLayout's script.
 */

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
    window.addEventListener("scroll", this.#onScroll, { passive: true });
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
    if (scrolledToBottom) {
      return this.#entries.at(-1)?.link ?? null;
    }

    // Headings are in document order, so the last one whose top has reached the
    // trigger line is the section currently being read; default to the first.
    let active = this.#entries[0]?.link ?? null;
    for (const { heading, link } of this.#entries) {
      if (heading.getBoundingClientRect().top <= TRIGGER_OFFSET) {
        active = link;
      }
    }
    return active;
  }
}

if (!customElements.get("blume-toc")) {
  customElements.define("blume-toc", BlumeToc);
}
