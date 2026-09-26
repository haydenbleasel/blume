import { withBasePath } from "../../core/base-path.ts";
import type { BlumeDataI18n } from "../../core/data.ts";
import { localizeRoute } from "../../core/i18n.ts";
import type { RouteSet } from "../../core/locale-links.ts";

/**
 * Routing by browser language (`i18n.routeByBrowserLanguage`): a visitor who
 * lands on the default language's home page from outside the site goes to
 * the home page in the first language their browser prefers that the site
 * has, until they pick a language with the switcher. It runs in the browser,
 * from the home page's head, so it works on a static host, and the redirect
 * happens before anything paints.
 */

/** Where a language picked with the switcher is remembered. */
export const LOCALE_STORAGE_KEY = "blume-locale";

/** What the home page's routing needs from the site. */
export interface LocaleRedirectContext {
  basePath: string;
  i18n: BlumeDataI18n | null;
  /** The page being rendered. */
  route: string;
  routes: RouteSet;
}

/**
 * The other languages' home pages a visitor could be sent to from `route`,
 * by locale code, or `null` when this page doesn't route: the option is off,
 * this isn't the default language's home, or no other home is served.
 */
export const browserLanguageTargets = (
  context: LocaleRedirectContext
): Record<string, string> | null => {
  const { i18n } = context;
  if (!i18n?.routeByBrowserLanguage) {
    return null;
  }
  const home = (code: string): string =>
    withBasePath(context.basePath, localizeRoute("/", code, i18n));
  if (context.route !== home(i18n.defaultLocale)) {
    return null;
  }
  const targets = i18n.locales
    .filter(({ code }) => code !== i18n.defaultLocale)
    .map(({ code }) => [code, home(code)] as const)
    .filter(([, path]) => context.routes.has(path));
  return targets.length > 0 ? Object.fromEntries(targets) : null;
};

/**
 * The inline script, given the default locale (`data-default`) and the other
 * homes (`data-targets`). For each language the browser prefers, in order, it
 * matches a locale by exact code, then by base language (`fr-CA` finds `fr`,
 * `pt` finds `pt-br`): the default language stays put, another one's home is
 * where the visitor goes. A visitor who picked a language, arrived from
 * another page of the site, or whose storage can't be read stays too.
 */
export const LOCALE_REDIRECT_SCRIPT = `(()=>{const s=document.currentScript;if(!s)return;try{if(localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})!==null)return}catch{return}if(document.referrer.startsWith(location.origin+"/"))return;let t;try{t=JSON.parse(s.dataset.targets||"")}catch{return}const d=s.dataset.default||"";const c=[d,...Object.keys(t)];const low=(v)=>v.toLowerCase();const base=(v)=>low(v).split("-")[0];for(const l of navigator.languages||[]){const m=c.find((v)=>low(v)===low(l))||c.find((v)=>low(v)===base(l))||c.find((v)=>base(v)===base(l));if(m===d)return;if(m){location.replace(t[m]+location.search+location.hash);return}}})();`;

/** A click target that can look up its ancestors: an element. */
interface ClosestTarget {
  closest: (selector: string) => {
    getAttribute: (name: string) => string | null;
  } | null;
}

/** A click, as the listener reads it. */
interface Click {
  target: EventTarget | ClosestTarget | null;
}

/** What {@link rememberLocaleChoice} listens on: the document. */
export interface ChoiceTarget {
  addEventListener: (type: "click", listener: (event: Click) => void) => void;
}

const hasClosest = (target: Click["target"]): target is ClosestTarget =>
  target !== null && "closest" in target;

/** The code of the switcher link a click landed on, if any. */
const chosenCode = (target: Click["target"]): string | null | undefined =>
  hasClosest(target)
    ? target.closest("a[data-blume-locale-choice]")?.getAttribute("hreflang")
    : null;

/**
 * Remember a language picked with the switcher, so routing by browser
 * language stops sending the reader elsewhere. One listener on the document
 * covers every switcher, on every page the client router swaps in.
 */
export const rememberLocaleChoice = (target: ChoiceTarget): void => {
  target.addEventListener("click", (event) => {
    const code = chosenCode(event.target);
    if (!code) {
      return;
    }
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, code);
    } catch {
      // Storage can be off; routing then stays off too (see the script).
    }
  });
};
