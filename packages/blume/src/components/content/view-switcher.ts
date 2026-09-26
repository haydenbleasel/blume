/**
 * The page view picker's logic (see `ViewSwitcher.astro`). A page written in
 * `<View title>` blocks shows one view at a time. The choice sits on
 * `<body data-blume-view>`, which each page brings fresh, and a per-page style
 * hides everything tagged with another view: the `<View>` blocks, the
 * picker's icons, and the table of contents entries for their headings.
 */

/** Where a reader's last-picked view is remembered, across pages. */
export const VIEW_STORAGE_KEY = "blume-view";

/** The query parameter a shared link picks a view with (`?view=Python`). */
export const VIEW_PARAM = "view";

/**
 * The view to show: the first of the candidates the page has, most specific
 * first (a linked heading's view, the link's `?view=`, the reader's last
 * pick), else the page's first view.
 */
export const chooseView = (
  titles: readonly string[],
  candidates: readonly (string | null | undefined)[]
): string | undefined =>
  candidates.find(
    (candidate): candidate is string =>
      candidate !== null &&
      candidate !== undefined &&
      titles.includes(candidate)
  ) ?? titles[0];

/**
 * A CSS string for `value`, safe inside a `<style>` element: quotes and
 * backslashes escaped, `<` as a hex escape so the text can't close the
 * element, and line breaks (which a CSS string can't hold) as spaces.
 */
const cssString = (value: string): string =>
  `"${value
    .replaceAll(/["\\]/gu, String.raw`\$&`)
    .replaceAll("<", String.raw`\3c `)
    .replaceAll(/[\n\r\f]/gu, " ")}"`;

/**
 * The page's view CSS: with a view chosen on `<body>`, everything tagged with
 * another is hidden; before a choice, everything but the first view is.
 */
export const viewStyle = (titles: readonly string[]): string => {
  const [first] = titles;
  if (first === undefined) {
    return "";
  }
  const other = (title: string): string =>
    `[data-blume-view]:not([data-blume-view=${cssString(title)}])`;
  const selectors = [
    `body:not([data-blume-view]) ${other(first)}`,
    ...titles.map(
      (title) => `body[data-blume-view=${cssString(title)}] ${other(title)}`
    ),
  ];
  return `${selectors.join(",")}{display:none!important}`;
};

/**
 * Runs inline as the picker is parsed, ahead of the views it controls, so a
 * link's `?view=` or the reader's last pick applies before anything paints.
 * Inline scripts run once per session under the client router; after that
 * the picker element applies the choice as each page swaps in.
 */
export const VIEW_INIT_SCRIPT = `(()=>{const s=document.currentScript;const p=s&&s.closest("blume-view-switcher");if(!p)return;let t=[];try{t=JSON.parse(p.getAttribute("data-views")||"[]")}catch{}let r=null;try{r=localStorage.getItem(${JSON.stringify(VIEW_STORAGE_KEY)})}catch{}const l=new URLSearchParams(location.search).get(${JSON.stringify(VIEW_PARAM)});const v=[l,r].find((c)=>c&&t.includes(c))||t[0];if(!v)return;document.body.setAttribute("data-blume-view",v);const e=p.querySelector("select");if(e)e.value=v;})();`;
