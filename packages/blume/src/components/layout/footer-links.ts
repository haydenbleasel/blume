import type { LocaleRouting } from "../../core/i18n.ts";
import { localizeHref } from "../../core/locale-links.ts";
import type { RouteSet } from "../../core/locale-links.ts";
import { resolveLocalizable } from "../../core/localizable.ts";
import type { ResolvedConfig } from "../../core/schema.ts";

/** The configured `footer.links`. */
type FooterLinks = NonNullable<ResolvedConfig["footer"]>["links"];

/** A footer link, ready to render. */
export interface FooterLinkItem {
  href: string;
  label: string;
}

/** What resolving needs from the site and the page. */
export interface FooterContext {
  basePath: string;
  /** The site's locales, when it has more than one. */
  i18n: LocaleRouting | null;
  /** The locale of the page being rendered. */
  locale?: string;
  routes: RouteSet;
}

/**
 * The footer's links in the page's locale: a label written as a per-locale
 * map shows that locale's entry (see `core/localizable.ts`), and an internal
 * link moves into the locale when it serves that page, the way content and
 * header links do, so a reader on `/fr/…` stays in French.
 */
export const footerLinks = (
  links: FooterLinks,
  context: FooterContext
): FooterLinkItem[] => {
  const { i18n, locale } = context;
  const defaultLocale = i18n?.defaultLocale;
  const localize = (href: string): string =>
    i18n && locale
      ? localizeHref(href, {
          basePath: context.basePath,
          // The layout mounts the deployment base afterwards.
          deployBase: "",
          i18n,
          locale,
          routes: context.routes,
        })
      : href;
  return links.map((link) => ({
    href: localize(link.href),
    label: resolveLocalizable(link.label, locale, defaultLocale),
  }));
};
