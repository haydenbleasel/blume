/**
 * Pre-paint inline scripts shared by the document layouts (`RootLayout`,
 * `PageLayout`, `ReferenceLayout`). They run synchronously — in `<head>`, or
 * immediately after the markup they act on — before that content paints, so the
 * page never flashes the wrong theme, a since-dismissed banner, or a sidebar
 * scrolled away from the current page. Kept in one place so the layouts can't
 * drift on this timing-critical logic.
 *
 * Under the client router (`<ClientRouter />`), each script's element reappears
 * on every navigated-to page but is executed only once per real page load —
 * Astro skips scripts whose content it has already run. Anything that must hold
 * per navigation therefore also registers an `astro:after-swap` listener on the
 * first (and only) execution: the swap replaces the `<html>` attributes and the
 * body wholesale, wiping `data-theme`/`data-blume-banner-hidden` and rebuilding
 * the sidebar, and `after-swap` fires before the new page paints — the same
 * no-flash timing the initial inline run has.
 *
 * All are constants, never built by interpolating config into source text: any
 * values they need ride in as `data-*` attributes on the script tag and are read
 * back through `document.currentScript`. Baking a config string into JS — even
 * via `JSON.stringify` — is code construction, and JSON escaping does not cover
 * a script context (`</script>`, U+2028/U+2029 all survive it). Attributes are
 * HTML-escaped by Astro, so the value can never be parsed as code.
 */

/**
 * Set `data-theme` from the stored preference (or the configured default, or the
 * OS setting for `"system"`) before the body paints, avoiding a theme flash —
 * and again after every client-router swap, which resets `<html>` attributes to
 * the incoming page's server-rendered (theme-less) set.
 *
 * Reads `data-mode` — `"system" | "light" | "dark"`.
 */
export const THEME_INIT_SCRIPT = `(()=>{const m=document.currentScript?.dataset.mode??"system";const apply=()=>{const s=localStorage.getItem("blume-theme");const sys=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=s??(m==="system"?sys:m);};apply();document.addEventListener("astro:after-swap",apply);})();`;

/**
 * Hide a previously-dismissed banner before it can flash in — and again after
 * every client-router swap, which wipes the `<html>` marker attribute.
 *
 * Reads `data-key` — the banner's dismissal key.
 */
export const BANNER_INIT_SCRIPT = `(()=>{const k=document.currentScript?.dataset.key;if(!k){return;}const apply=()=>{if(localStorage.getItem("blume-banner:"+k)){document.documentElement.setAttribute("data-blume-banner-hidden","");}};apply();document.addEventListener("astro:after-swap",apply);})();`;

/**
 * Keep the sidebar's scroll useful across page changes. The sidebar is its own
 * scroll container, reborn scrolled to the top whenever its markup is rebuilt —
 * on a long sidebar the viewport would visibly jump away from the link you just
 * clicked.
 *
 * On the initial load it centers the current page's link before the sidebar
 * paints (it runs inline immediately after the sidebar `<aside>`, not in
 * `<head>`: it needs that markup parsed). On client-router navigations it first
 * restores the exact scroll position saved at `astro:before-swap` — so clicking
 * through nearby links doesn't move the sidebar at all — and only re-centers
 * when the new page's link sits outside the visible scroll area.
 *
 * The lookup is scoped to the page tree (`data-blume-nav-tree`) because the
 * drawer also holds the mobile tabs list, whose active tab is `aria-current`
 * too. `getClientRects()` skips links that aren't rendered — `hidden` drill-in
 * panels and breakpoint-hidden duplicates — and centering no-ops when the
 * active link is already inside the visible scroll area, so a short sidebar
 * never moves.
 */
export const SIDEBAR_SCROLL_INIT_SCRIPT = `(()=>{const drawer=()=>document.querySelector("[data-blume-nav-drawer]");const center=()=>{const n=drawer();const s=n&&(n.querySelector("[data-blume-nav-tree]")||n);if(!s)return;let l=null;for(const a of s.querySelectorAll('a[aria-current="page"]')){if(a.getClientRects().length){l=a;break;}}if(!l)return;const r=n.getBoundingClientRect();const t=l.getBoundingClientRect();if(t.top>=r.top&&t.bottom<=r.bottom)return;n.scrollTop+=t.top-r.top-(n.clientHeight-t.height)/2;};let saved=-1;document.addEventListener("astro:before-swap",()=>{const n=drawer();saved=n?n.scrollTop:-1;});document.addEventListener("astro:after-swap",()=>{const n=drawer();if(n&&saved>=0){n.scrollTop=saved;}center();});center();})();`;
