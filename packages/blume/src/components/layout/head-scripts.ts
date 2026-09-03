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
 * Re-applying on `astro:after-swap` alone is too late for CSS transitions: the
 * router's `swapRootAttributes` drops `data-theme`, then its scroll restoration
 * (`scrollTo`) forces a style flush before `after-swap` fires, so every
 * `transition-colors` element in the new body gets a light-theme computed
 * style and animates to dark once the attribute returns. `astro:before-swap`
 * therefore stamps the current theme onto the incoming document's root, so the
 * attribute swap carries it over and the theme never drops in the first place;
 * the `after-swap` re-apply stays as the fallback that also picks up a
 * preference changed in another tab.
 *
 * Reads `data-mode` — `"system" | "light" | "dark"`.
 */
export const THEME_INIT_SCRIPT = `(()=>{const m=document.currentScript?.dataset.mode??"system";const apply=()=>{const s=localStorage.getItem("blume-theme");const sys=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=s??(m==="system"?sys:m);};apply();document.addEventListener("astro:before-swap",(e)=>{const t=document.documentElement.dataset.theme;if(t){e.newDocument.documentElement.dataset.theme=t;}});document.addEventListener("astro:after-swap",apply);})();`;

/**
 * Hide a previously-dismissed banner before it can flash in — and again after
 * every client-router swap, which wipes the `<html>` marker attribute.
 *
 * Reads `data-key` — the banner's dismissal key.
 */
export const BANNER_INIT_SCRIPT = `(()=>{const k=document.currentScript?.dataset.key;if(!k){return;}const apply=()=>{if(localStorage.getItem("blume-banner:"+k)){document.documentElement.setAttribute("data-blume-banner-hidden","");}};apply();document.addEventListener("astro:after-swap",apply);})();`;

/**
 * Keep the page styled across client-router swaps. Astro hoists the CSS of a
 * component rendered after the head has streamed (the page's MDX content, the
 * WebMcp island) into the **body** as `<link rel="stylesheet">` tags — and the
 * client router only preloads and persists stylesheets it finds in the head.
 * A swapped-in body `<link>` applies asynchronously, so every navigation to a
 * page with body CSS painted one or two completely unstyled frames (giant raw
 * SVG logo, default link colors) before the sheet kicked in — even when the
 * same sheet was already loaded on the outgoing page, because the swap throws
 * the old body (and its link element) away.
 *
 * Two listeners close the gap. `astro:before-preparation` wraps the router's
 * loader: after the next document is fetched, any of its body stylesheets not
 * already in the live head are appended there and awaited, so their rules
 * apply before the swap. `astro:before-swap` then moves the incoming
 * document's body stylesheets into its head, where the router's head diff
 * keeps the already-loaded copy (matched by `href`) instead of re-inserting a
 * fresh, not-yet-applied link — and drops it again on a later navigation to a
 * page that doesn't use it. A sheet that fails to load resolves rather than
 * wedging the navigation; the page renders as it would have without this.
 */
export const SWAP_STYLESHEET_INIT_SCRIPT = `(()=>{const sel='body link[rel="stylesheet"]';document.addEventListener("astro:before-preparation",(e)=>{const load=e.loader;e.loader=async()=>{await load();const links=[...e.newDocument.querySelectorAll(sel)].filter((l)=>!document.head.querySelector('link[rel="stylesheet"][href="'+l.getAttribute("href")+'"]'));await Promise.all(links.map((l)=>new Promise((done)=>{const c=document.createElement("link");for(const a of l.attributes){c.setAttribute(a.name,a.value);}c.onload=done;c.onerror=done;document.head.append(c);})));};});document.addEventListener("astro:before-swap",(e)=>{for(const l of e.newDocument.querySelectorAll(sel)){e.newDocument.head.append(l);}});})();`;

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
