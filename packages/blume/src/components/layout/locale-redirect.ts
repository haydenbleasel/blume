import { withBasePath } from "../../core/base-path.ts";
import type { BlumeDataI18n } from "../../core/data.ts";
import { localizeRoute } from "../../core/i18n.ts";
import type { RouteSet } from "../../core/locale-links.ts";
import { LOCALE_STORAGE_KEY } from "./locale-choice.ts";

// The switcher's half moved to locale-choice.ts, so the switcher's browser
// bundle stays clear of this module's imports. It's still importable from
// here, where it used to live.
export { LOCALE_STORAGE_KEY, rememberLocaleChoice } from "./locale-choice.ts";
export type { ChoiceTarget } from "./locale-choice.ts";

/**
 * Routing by browser language (`i18n.routeByBrowserLanguage`): a visitor who
 * lands on the default language's home page from outside the site goes to
 * the home page in the first language their browser prefers that the site
 * has, until they pick a language with the switcher. It runs in the browser,
 * from the home page's head, so it works on a static host, and the redirect
 * happens before anything paints.
 */

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
 * The inline script, given the default locale (`data-default`), the other
 * homes (`data-targets`), and the path the site is served from, with its
 * trailing slash (`data-base`). For each language the browser prefers, in
 * order, it matches a locale by exact code, then by base language (`fr-CA`
 * finds `fr`, `pt` finds `pt-br`): the default language stays put, another
 * one's home is where the visitor goes. A visitor who picked a language,
 * arrived from another page of the site, or whose storage can't be read stays
 * too.
 *
 * Arriving from the site means two things. The client router runs the script
 * when it swaps the home page in, and `document.referrer` still names
 * wherever the visitor first came from, so the script only acts while the
 * document is loading: a reader already browsing stays. On a real page load,
 * the referrer is in the site when it's under the site's base. Under
 * `deployment.base`, the rest of the origin is someone else's.
 */
export const LOCALE_REDIRECT_SCRIPT = `(()=>{const s=document.currentScript;if(!s||document.readyState!=="loading")return;try{if(localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})!==null)return}catch{return}if((document.referrer.split("?")[0]+"/").startsWith(location.origin+(s.dataset.base||"/")))return;let t;try{t=JSON.parse(s.dataset.targets||"")}catch{return}const d=s.dataset.default||"";const c=[d,...Object.keys(t)];const low=(v)=>v.toLowerCase();const base=(v)=>low(v).split("-")[0];for(const l of navigator.languages||[]){const m=c.find((v)=>low(v)===low(l))||c.find((v)=>low(v)===base(l))||c.find((v)=>base(v)===base(l));if(m===d)return;if(m){location.replace(t[m]+location.search+location.hash);return}}})();`;
