/**
 * Site-wide meta tags (`seo.metatags`): tags written into every page's head,
 * for what Blume has no setting of its own for, such as site-verification
 * tokens, `theme-color`, or an app banner. The tags Blume writes itself are
 * refused, each pointing at the setting that controls it, so a page never
 * carries two values for one tag.
 */

const IMAGE =
  "`seo.og` for the generated cards, or `seo.image` in a page's frontmatter";
const TITLE = "`title`, or `seo.title` in a page's frontmatter";
const DESCRIPTION =
  "`description` in a page's frontmatter or the config, or a page's `seo.description`";
const FROM_PAGE = "Blume sets it from each page's type and dates";

/** The tags Blume writes itself, by lowercase name, and what sets each. */
const OWNED = new Map([
  ["article:modified_time", FROM_PAGE],
  ["article:published_time", FROM_PAGE],
  ["description", DESCRIPTION],
  ["og:description", DESCRIPTION],
  ["og:site_name", "the config's `title`"],
  ["og:title", TITLE],
  ["og:type", FROM_PAGE],
  ["og:url", "`deployment.site`, which sets each page's canonical URL"],
  ["robots", "`seo.noindex` in a page's frontmatter"],
  ["twitter:card", "Blume sets it from each page's image"],
  ["twitter:creator", "`seo.x.creator` in the config or a page's frontmatter"],
  ["twitter:description", DESCRIPTION],
  ["twitter:site", "`seo.x.handle`"],
  ["twitter:title", TITLE],
  ["viewport", "Blume sets it for every page"],
]);

/** `og:image` and `twitter:image`, and their sub-properties. */
const IMAGE_TAG = /^(?:og|twitter):image(?::|$)/u;

/**
 * What sets a tag Blume writes itself, or `undefined` for a tag the site can
 * add.
 */
export const ownedMetatag = (name: string): string | undefined => {
  const key = name.trim().toLowerCase();
  return IMAGE_TAG.test(key) ? IMAGE : OWNED.get(key);
};

/**
 * The Open Graph families, which the protocol names with `property`; every
 * other tag takes `name`.
 */
const PROPERTY_TAG =
  /^(?:og|fb|article|book|profile|music|video|al|product):/iu;

/** One site-wide tag, as its `<meta>` element's attributes. */
export interface MetatagAttributes {
  content: string;
  name?: string;
  property?: string;
}

/** The site's `seo.metatags` as `<meta>` attributes, in the order written. */
export const metatagAttributes = (
  tags?: Readonly<Record<string, string>> | null
): MetatagAttributes[] =>
  Object.entries(tags ?? {}).map(([name, content]) =>
    PROPERTY_TAG.test(name) ? { content, property: name } : { content, name }
  );
