/**
 * Keep the mobile nav drawer out of the tab order while it is closed. The
 * closed drawer is only translated off-canvas, so its links would otherwise
 * stay focusable on every page. Mirrors the header's `data-blume-nav-open`
 * toggle into `inert`/`aria-hidden` — but only below `lg` (64rem), where the
 * same element isn't the static sidebar (RootLayout) or is display-hidden
 * anyway (PageLayout). Shared by both layouts' bundled scripts, which run once
 * per real page load; the drawer element is rebuilt by every client-router
 * swap, so `sync` re-queries it each time and re-runs on `astro:after-swap`.
 */
export const syncDrawerInert = (): void => {
  const desktop = window.matchMedia("(min-width: 64rem)");
  const sync = () => {
    const drawer = document.querySelector<HTMLElement>(
      "[data-blume-nav-drawer]"
    );
    if (!drawer) {
      return;
    }
    const hidden =
      !desktop.matches &&
      !Object.hasOwn(document.documentElement.dataset, "blumeNavOpen");
    drawer.inert = hidden;
    if (hidden) {
      drawer.setAttribute("aria-hidden", "true");
    } else {
      drawer.removeAttribute("aria-hidden");
    }
  };
  sync();
  desktop.addEventListener("change", sync);
  new MutationObserver(sync).observe(document.documentElement, {
    attributeFilter: ["data-blume-nav-open"],
  });
  document.addEventListener("astro:after-swap", sync);
};
